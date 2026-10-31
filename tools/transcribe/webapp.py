#!/usr/bin/env python3
"""Transcribe web app.

Paste a reel/video/audio link or upload a file, get the full transcription on
screen, and save it with the "Save as text" button.

  PORT=12001 python3 webapp.py     # then open the sandbox URL for that port

Reuses the pipeline in vtx.py (yt-dlp -> ffmpeg -> local faster-whisper, plus
an optional Gemini explanation).
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import vtx  # noqa: E402

# Whisper models are memory-hungry; run one transcription at a time.
TRANSCRIBE_LOCK = threading.Lock()

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcribe - audio to text</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: #0f1115; color: #e6e8ec; }
  header { padding: 22px 20px 8px; max-width: 900px; margin: 0 auto; }
  h1 { margin: 0 0 4px; font-size: 22px; }
  p.sub { margin: 0; color: #98a0ad; font-size: 14px; }
  main { max-width: 900px; margin: 0 auto; padding: 16px 20px 60px; }
  .card { background: #171a21; border: 1px solid #262b35; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
  label { display: block; font-size: 13px; color: #98a0ad; margin-bottom: 6px; }
  input[type=text], select, textarea { width: 100%; background: #0f1115; color: #e6e8ec;
    border: 1px solid #303643; border-radius: 8px; padding: 10px 12px; font: inherit; }
  textarea { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 14px; min-height: 320px; resize: vertical; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; align-items: end; }
  .row > div { flex: 1 1 200px; }
  button { font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 10px 16px; cursor: pointer; }
  .primary { background: #4f7cff; color: #fff; }
  .primary:disabled { opacity: .5; cursor: default; }
  .ghost { background: #232936; color: #e6e8ec; border: 1px solid #333b4a; }
  .save { background: #16a34a; color: #fff; font-size: 15px; padding: 12px 20px; }
  .bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
  .status { color: #98a0ad; font-size: 14px; }
  .status.err { color: #ff7b72; }
  .hidden { display: none; }
  .meta { color: #98a0ad; font-size: 13px; margin: 0 0 10px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .04em; color: #98a0ad; margin: 0 0 10px; }
  .spin { display: inline-block; width: 14px; height: 14px; border: 2px solid #4f7cff;
    border-right-color: transparent; border-radius: 50%; animation: s .7s linear infinite; vertical-align: -2px; }
  @keyframes s { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<header>
  <h1>Transcribe - audio to text</h1>
  <p class="sub">Paste a video/reel link or upload an audio/video file. Get the full transcription, then save it as text.</p>
</header>
<main>
  <div class="card">
    <div class="row">
      <div style="flex:1 1 100%">
        <label for="url">Video / reel URL</label>
        <input id="url" type="text" placeholder="https://www.facebook.com/reel/... or https://youtube.com/watch?v=...">
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <div>
        <label for="file">...or upload an audio / video file</label>
        <input id="file" type="file" accept="audio/*,video/*">
      </div>
      <div style="flex:0 1 160px">
        <label for="model">Model</label>
        <select id="model">
          <option value="tiny">tiny (fastest)</option>
          <option value="base" selected>base</option>
          <option value="small">small (better)</option>
          <option value="medium">medium (slow)</option>
        </select>
      </div>
      <div style="flex:0 1 160px">
        <label for="lang">Language</label>
        <select id="lang">
          <option value="auto" selected>auto-detect</option>
          <option value="en">English</option>
          <option value="ar">Arabic</option>
          <option value="fr">French</option>
        </select>
      </div>
      <div style="flex:0 0 auto">
        <button id="go" class="primary">Transcribe</button>
      </div>
    </div>
    <div id="status" class="status" style="margin-top:12px"></div>
  </div>

  <div id="result" class="card hidden">
    <p id="meta" class="meta"></p>
    <div class="bar">
      <button id="saveTxt" class="save">Save as text</button>
      <button id="copy" class="ghost">Copy</button>
      <span id="saved" class="status"></span>
    </div>
    <h2>Full transcription</h2>
    <textarea id="transcript" readonly></textarea>
    <div id="aiWrap" class="hidden" style="margin-top:16px">
      <h2>Explanation</h2>
      <textarea id="explanation" readonly style="min-height:220px"></textarea>
    </div>
  </div>
</main>
<script>
const $ = (id) => document.getElementById(id);
const state = { slug: "transcript", transcript: "" };
const setStatus = (msg, isErr) => {
  const el = $("status");
  el.className = "status" + (isErr ? " err" : "");
  el.innerHTML = msg;
};
const busy = (on) => { $("go").disabled = on; };

async function start() {
  const url = $("url").value.trim();
  const file = $("file").files[0];
  if (!url && !file) { setStatus("Paste a URL or choose a file first.", true); return; }
  $("result").classList.add("hidden");
  busy(true);
  setStatus('<span class="spin"></span> Working... downloading and transcribing locally. This can take a moment.');
  try {
    let res;
    if (file) {
      const q = new URLSearchParams({ name: file.name, model: $("model").value, lang: $("lang").value });
      res = await fetch("/api/transcribe-file?" + q, { method: "POST", body: file });
    } else {
      res = await fetch("/api/transcribe-url", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, model: $("model").value, lang: $("lang").value }),
      });
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "transcription failed");
    show(data);
  } catch (e) {
    setStatus("Error: " + e.message, true);
  } finally {
    busy(false);
  }
}

function show(d) {
  state.slug = d.slug || "transcript";
  state.transcript = d.transcript || "";
  $("transcript").value = d.transcript || "(no speech detected)";
  $("meta").textContent = [d.title, d.extractor, d.duration && d.duration !== "n/a" ? d.duration + "s" : null,
    "language: " + d.lang].filter(Boolean).join("  |  ");
  if (d.explanation) { $("explanation").value = d.explanation; $("aiWrap").classList.remove("hidden"); }
  else { $("aiWrap").classList.add("hidden"); }
  $("result").classList.remove("hidden");
  setStatus("Done. " + (d.plain || "").split(/\\s+/).filter(Boolean).length + " words transcribed.");
  $("saved").textContent = "";
}

function saveText() {
  const blob = new Blob([state.transcript || ""], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = state.slug + ".transcript.txt";
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
  $("saved").textContent = "Saved " + a.download;
}

async function copyText() {
  try { await navigator.clipboard.writeText($("transcript").value); $("saved").textContent = "Copied."; }
  catch (e) { $("saved").textContent = "Copy failed - select and copy manually."; }
}

$("go").addEventListener("click", start);
$("saveTxt").addEventListener("click", saveText);
$("copy").addEventListener("click", copyText);
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") start(); });
</script>
</body>
</html>
"""


def transcribe_source(*, url=None, upload_path=None, model="base", lang="auto") -> dict:
    """Run the vtx pipeline and return a JSON-ready dict."""
    ffmpeg = vtx.find_ffmpeg()
    workdir = Path(tempfile.mkdtemp(prefix="vtx-web-"))
    meta = {"title": Path(upload_path).name if upload_path else "video",
            "extractor": "file", "duration": "n/a", "url": url or ""}
    if url:
        try:
            meta = vtx.probe(url, None)
        except Exception:
            pass

    with TRANSCRIBE_LOCK:
        audio_src = upload_path or vtx.download_audio(url, workdir, None, ffmpeg)
        audio = vtx.decode_to_float32(Path(audio_src), ffmpeg)
        if audio.size == 0:
            raise RuntimeError("no audio track found")
        segments, detected = vtx.transcribe(audio, model, lang)

    stamped, plain = vtx.render_transcript(segments)
    explanation = None
    key = os.environ.get("OHGeminiAPI") or os.environ.get("GEMINI_API_KEY")
    if not key:
        print("  [explain] skipped: no OHGeminiAPI/GEMINI_API_KEY in the server env", flush=True)
    elif not plain:
        print("  [explain] skipped: empty transcript", flush=True)
    else:
        try:
            explanation = vtx.explain(plain, key)
            print("  [explain] ok", flush=True)
        except Exception as exc:
            print(f"  [explain] failed: {type(exc).__name__}: {exc}", flush=True)

    return {
        "ok": True,
        "title": meta.get("title"),
        "extractor": meta.get("extractor"),
        "duration": meta.get("duration"),
        "lang": detected,
        "slug": vtx.slugify(meta.get("title") or "transcript"),
        "transcript": stamped,
        "plain": plain,
        "explanation": explanation,
    }


class Handler(BaseHTTPRequestHandler):
    server_version = "vtx-web"

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj: dict) -> None:
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_GET(self):
        if urlparse(self.path).path in ("/", "/index.html"):
            self._send(200, PAGE.encode(), "text/html; charset=utf-8")
        elif urlparse(self.path).path == "/health":
            self._json(200, {"ok": True})
        else:
            self._json(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/transcribe-url":
                length = int(self.headers.get("Content-Length", 0))
                data = json.loads(self.rfile.read(length) or b"{}")
                url = (data.get("url") or "").strip()
                if not url:
                    return self._json(400, {"ok": False, "error": "missing url"})
                result = transcribe_source(url=url, model=data.get("model", "base"),
                                           lang=data.get("lang", "auto"))
            elif parsed.path == "/api/transcribe-file":
                q = parse_qs(parsed.query)
                name = (q.get("name", ["upload"])[0] or "upload").replace("/", "_")
                length = int(self.headers.get("Content-Length", 0))
                if length <= 0:
                    return self._json(400, {"ok": False, "error": "empty upload"})
                tmpdir = Path(tempfile.mkdtemp(prefix="vtx-up-"))
                dest = tmpdir / name
                remaining = length
                with dest.open("wb") as fh:
                    while remaining > 0:
                        chunk = self.rfile.read(min(1 << 20, remaining))
                        if not chunk:
                            break
                        fh.write(chunk)
                        remaining -= len(chunk)
                result = transcribe_source(upload_path=str(dest), model=q.get("model", ["base"])[0],
                                           lang=q.get("lang", ["auto"])[0])
            else:
                return self._json(404, {"ok": False, "error": "not found"})
            self._json(200, result)
        except Exception as exc:
            traceback.print_exc()
            self._json(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"})


def main() -> int:
    port = int(os.environ.get("PORT", "12001"))
    srv = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print(f"transcribe web app on http://0.0.0.0:{port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
