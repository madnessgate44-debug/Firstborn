#!/usr/bin/env python3
"""vtx - video/reel -> full transcription + AI explanation.

Paste a YouTube or Facebook (Reels/watch) URL (or any yt-dlp-supported site,
or a local file) and get:

  <out>/<slug>.transcript.txt   timestamped plain-text transcript
  <out>/<slug>.md               transcript + AI explanation (summary, key
                                points, walkthrough, topics, takeaways)

Transcription runs locally (faster-whisper, CPU). The explanation step uses
Google Gemini and needs OHGeminiAPI in the environment; pass --no-ai to skip it.

Usage:
  python3 vtx.py <URL|FILE> [--out DIR] [--model tiny|base|small|medium]
                 [--lang auto|en|ar|fr|...] [--cookies FILE] [--no-ai]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

GEMINI_MODEL = "gemini-2.5-flash"
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{m}:generateContent?key={k}"

EXPLAIN_PROMPT = """You are explaining a video to someone who has not watched it.

Write a full, self-contained explanation of the video below, using the
timestamped transcript. Cover, in this order:

1. **What it is** - one sentence on what the video is and its likely purpose.
2. **Summary** - a paragraph covering the whole thing end to end.
3. **Key points** - a bullet list of the distinct ideas, in order. Reuse the
   exact `[mm:ss]` timestamps that appear in the transcript; never invent one.
4. **Walkthrough** - a section-by-section explanation of what happens and why.
5. **Topics / keywords** - a short comma-separated list.
6. **Takeaways** - what a viewer should remember or do.

Be faithful to the transcript. Do not invent facts that are not present. If
something is unclear, say so. Write in the language of the transcript.

TRANSCRIPT:
---
{transcript}
---
"""


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def find_ffmpeg() -> str:
    """Return a usable ffmpeg path (system, then the static imageio build)."""
    from shutil import which

    sys_ffmpeg = which("ffmpeg")
    if sys_ffmpeg:
        return sys_ffmpeg
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as exc:  # pragma: no cover - environment dependent
        raise SystemExit(
            "ffmpeg not found. Install it, or `pip install imageio-ffmpeg`. "
            f"({exc})"
        )


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, text=True, capture_output=True, **kw)


def is_url(target: str) -> bool:
    return bool(re.match(r"^https?://", target, re.I))


def slugify(text: str) -> str:
    text = re.sub(r"[^\w\s-]", "", text, flags=re.UNICODE).strip().lower()
    text = re.sub(r"[\s_-]+", "-", text)
    return text[:60] or "video"


def probe(target: str, cookies: str | None) -> dict:
    """Ask yt-dlp for metadata without downloading."""
    cmd = [sys.executable, "-m", "yt_dlp", "--no-warnings", "--skip-download",
           "--print", "%(title)s\n%(id)s\n%(duration)s\n%(extractor)s\n%(webpage_url)s"]
    if cookies:
        cmd += ["--cookies", cookies]
    cmd.append(target)
    res = run(cmd)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip().splitlines()[-1] if res.stderr else "probe failed")
    title, vid, dur, extractor, url = (res.stdout.strip().splitlines() + [""] * 5)[:5]
    return {"title": title, "id": vid, "duration": dur, "extractor": extractor, "url": url}


def try_youtube_captions(target: str, lang: str) -> str | None:
    """Fallback for YouTube when media download is blocked: fetch captions.

    Datacenter IPs are frequently refused by YouTube's media endpoints; the
    caption endpoint is sometimes still reachable.
    """
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except Exception:
        return None

    m = re.search(r"(?:v=|youtu\.be/|shorts/|embed/)([A-Za-z0-9_-]{6,})", target)
    if not m:
        return None
    try:
        langs = [lang] if lang and lang != "auto" else ["en", "ar", "fr"]
        fetched = YouTubeTranscriptApi().fetch(m.group(1), languages=langs)
        lines = []
        for s in fetched.snippets:
            mm, ss = divmod(int(s.start), 60)
            lines.append(f"[{mm:02d}:{ss:02d}] {s.text.strip()}")
        return "\n".join(lines)
    except Exception as exc:
        log(f"  caption fallback failed: {type(exc).__name__}: {exc}")
        return None


def download_audio(target: str, workdir: Path, cookies: str | None, ffmpeg: str) -> Path:
    """Download the best audio track and convert it to 16 kHz mono WAV."""
    out_tmpl = str(workdir / "audio.%(ext)s")
    cmd = [sys.executable, "-m", "yt_dlp", "--no-warnings", "--no-playlist",
           "-f", "bestaudio/best", "-x", "--audio-format", "wav",
           "--postprocessor-args", "-ar 16000 -ac 1",
           "--ffmpeg-location", ffmpeg, "-o", out_tmpl]
    if cookies:
        cmd += ["--cookies", cookies]
    cmd.append(target)
    res = run(cmd)
    if res.returncode != 0:
        tail = (res.stderr or res.stdout).strip().splitlines()[-4:]
        raise RuntimeError("download failed:\n  " + "\n  ".join(tail))
    wavs = sorted(workdir.glob("audio*.wav"))
    if not wavs:
        raise RuntimeError("download produced no audio file")
    return wavs[0]


def decode_to_float32(path: Path, ffmpeg: str) -> "object":
    """Decode any media file to a 16 kHz mono float32 numpy array.

    We decode with ffmpeg rather than letting faster-whisper use PyAV, because
    some PyAV releases are incompatible with the installed faster-whisper.
    """
    import numpy as np

    cmd = [ffmpeg, "-nostdin", "-i", str(path), "-f", "f32le",
           "-ac", "1", "-ar", "16000", "-"]
    res = subprocess.run(cmd, capture_output=True)
    if res.returncode != 0:
        raise RuntimeError("ffmpeg decode failed: " + res.stderr.decode(errors="ignore")[-300:])
    return np.frombuffer(res.stdout, dtype=np.float32)


def transcribe(audio, model_size: str, lang: str) -> tuple[list[dict], str]:
    from faster_whisper import WhisperModel

    log(f"  loading whisper '{model_size}' (cpu/int8)...")
    model = WhisperModel(model_size, device="cpu", compute_type="int8")
    segments, info = model.transcribe(
        audio,
        language=None if lang in ("auto", "", None) else lang,
        vad_filter=True,
        beam_size=5,
    )
    out = []
    for s in segments:
        out.append({"start": s.start, "end": s.end, "text": s.text.strip()})
    return out, info.language


def render_transcript(segments: list[dict]) -> tuple[str, str]:
    """Return (plain timestamped text, plain text without timestamps)."""
    stamped, plain = [], []
    for s in segments:
        mm, ss = divmod(int(s["start"]), 60)
        stamped.append(f"[{mm:02d}:{ss:02d}] {s['text']}")
        plain.append(s["text"])
    return "\n".join(stamped), " ".join(plain).strip()


def explain(plain_transcript: str, api_key: str) -> str:
    body = {"contents": [{"parts": [{"text": EXPLAIN_PROMPT.format(transcript=plain_transcript)}]}]}
    req = urllib.request.Request(
        GEMINI_URL.format(m=GEMINI_MODEL, k=api_key),
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    return data["candidates"][0]["content"]["parts"][0]["text"].strip()


def build_markdown(meta: dict, stamped: str, plain: str, explanation: str | None, lang: str) -> str:
    src = meta.get("url") or meta.get("extractor", "")
    head = [
        f"# {meta.get('title', 'Video')}",
        "",
        f"- **Source:** {src}",
        f"- **Platform:** {meta.get('extractor', 'n/a')}",
        f"- **Duration:** {meta.get('duration', 'n/a')}s",
        f"- **Detected language:** {lang}",
        "",
    ]
    parts = ["\n".join(head)]
    if explanation:
        parts += ["## AI explanation", "", explanation, ""]
    parts += ["## Transcript", "", stamped, ""]
    parts += ["## Transcript (plain)", "", plain, ""]
    return "\n".join(parts)


def process(target: str, args) -> int:
    ffmpeg = find_ffmpeg()
    out_dir = Path(args.out).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    meta = {"title": Path(target).stem, "extractor": "file", "duration": "n/a", "url": target}
    if is_url(target):
        log(f"[1/4] probing {target}")
        try:
            meta = probe(target, args.cookies)
        except Exception as exc:
            log(f"  probe failed ({exc}); continuing with defaults")

    slug = slugify(meta.get("title", "video"))
    log(f"  title: {meta.get('title')}  ({meta.get('duration')}s, {meta.get('extractor')})")

    log("[2/4] obtaining audio")
    segments = None
    lang = args.lang
    try:
        audio_path = target if not is_url(target) else download_audio(target, out_dir, args.cookies, ffmpeg)
        log(f"  audio: {audio_path}")
        log("[3/4] transcribing locally")
        audio = decode_to_float32(Path(audio_path), ffmpeg)
        if audio.size == 0:
            raise RuntimeError("decoded audio is empty")
        segments, lang = transcribe(audio, args.model, args.lang)
        log(f"  {len(segments)} segments, language={lang}")
    except Exception as exc:
        log(f"  audio path failed: {exc}")
        if is_url(target):
            log("  trying YouTube caption fallback")
            cap = try_youtube_captions(target, args.lang)
            if cap:
                stamped, plain = cap, " ".join(l.split("] ", 1)[-1] for l in cap.splitlines())
                return write_outputs(out_dir, slug, meta, stamped, plain, args, lang)
        raise

    stamped, plain = render_transcript(segments)
    return write_outputs(out_dir, slug, meta, stamped, plain, args, lang)


def write_outputs(out_dir: Path, slug: str, meta: dict, stamped: str, plain: str, args, lang: str) -> int:
    (out_dir / f"{slug}.transcript.txt").write_text(stamped + "\n", encoding="utf-8")

    explanation = None
    if not args.no_ai:
        key = os.environ.get("OHGeminiAPI") or os.environ.get("GEMINI_API_KEY")
        if key:
            log(f"[4/4] asking Gemini ({GEMINI_MODEL}) for the explanation")
            try:
                explanation = explain(plain, key)
            except Exception as exc:
                log(f"  explanation failed: {type(exc).__name__}: {exc}")
        else:
            log("[4/4] no OHGeminiAPI/GEMINI_API_KEY set - skipping explanation")

    md = build_markdown(meta, stamped, plain, explanation, lang)
    (out_dir / f"{slug}.md").write_text(md, encoding="utf-8")
    log(f"done -> {out_dir / (slug + '.md')}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="Video/reel -> transcript + AI explanation")
    p.add_argument("target", help="URL (YouTube, Facebook Reels/watch, ...) or a local media file")
    p.add_argument("--out", default="./out", help="output directory (default ./out)")
    p.add_argument("--model", default="small", help="whisper model: tiny|base|small|medium|large-v3")
    p.add_argument("--lang", default="auto", help="force language (e.g. en, ar, fr) or 'auto'")
    p.add_argument("--cookies", default=None, help="cookies.txt for login-walled content")
    p.add_argument("--no-ai", action="store_true", help="skip the Gemini explanation")
    args = p.parse_args()
    try:
        return process(args.target, args)
    except Exception as exc:
        log(f"ERROR: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
