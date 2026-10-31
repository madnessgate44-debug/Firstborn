# Transcribe - paste a reel/video, get a transcript + explanation

A small, self-contained tool in this repo. Paste a Facebook Reel / Facebook
video / YouTube link (or any [yt-dlp](https://github.com/yt-dlp/yt-dlp)-supported
site, or a local file) and get a full timestamped transcript, with an optional
AI explanation.

It is Python, and it sits next to the TypeScript app - it does not affect
`npm run lint`, `npm run build`, or `npm test`.

## What you get

- a **full transcription** on screen (web app) or `<slug>.transcript.txt` (CLI)
- a **Save as text** button that downloads the transcription as a `.txt`
- optionally, an AI **explanation**: what it is, summary, key points with
  timestamps, walkthrough, topics, takeaways

Transcription runs locally (faster-whisper on CPU). Only the optional
explanation calls out to Google.

## Run it from the repo - step by step

### 0. Prerequisites

- **Python 3.10+** (`python3 --version`). Tested on 3.13.
- **~1 GB free disk** for the Whisper model (downloaded once on first run).
- Internet access, to fetch the video and (optionally) the AI explanation.
- No `ffmpeg` install needed - a static build comes from `imageio-ffmpeg`.

### 1. Get the files

If you already have this repo cloned, you have them:

```bash
cd tools/transcribe
```

### 2. Install the dependencies (one command)

```bash
python3 -m pip install -r requirements.txt
```

### 3. (Optional) Add a free Gemini key for the AI explanation

Without it you still get the full transcript; only the explanation is hidden.
Get a free key at <https://aistudio.google.com/apikey> (free tier, no card),
then in the same terminal:

```bash
export OHGeminiAPI=your_key_here      # macOS/Linux
# set OHGeminiAPI=your_key_here       # Windows PowerShell
```

### 4a. Option A - the web app (has the "Save as text" button)

```bash
PORT=8000 python3 webapp.py
```

Open <http://localhost:8000>, then:

1. Paste a reel/video URL in the box, **or** choose an audio/video file.
2. Press **Transcribe** (the first run downloads the model, so it is slower).
3. Read the full transcription, then click **Save as text** - it downloads
   `<title>.transcript.txt`. Use **Copy** to put it on the clipboard instead.

Change the port with `PORT=...` if 8000 is taken.

### 4b. Option B - the command line

```bash
python3 vtx.py "https://www.facebook.com/reel/<id>"
# -> ./out/<slug>.transcript.txt   (timestamped transcript)
# -> ./out/<slug>.md               (transcript + AI explanation)
```

Options: `--out DIR`, `--model tiny|base|small|medium|large-v3` (default
`small`), `--lang en|ar|fr|auto`, `--cookies cookies.txt` (for login-walled
content), `--no-ai` (transcript only).

### Troubleshooting

- First transcription is slow: the Whisper model downloads once, then is cached.
- `ffmpeg not found`: run `python3 -m pip install imageio-ffmpeg` and retry.
- No explanation appears: `OHGeminiAPI` is not set in the terminal that is
  running the app. Export it and restart the command.
- YouTube returns 403 / blocked: that is an IP block on datacenter/VPN
  connections. Add `--cookies cookies.txt`, or run from a home connection.
  (`operator:` the web app does not expose cookies yet.)

## Verified

2026-10-31: a Facebook Reel URL and an uploaded `.mp4` both produced a
transcript, and **Save as text** wrote a 702-byte `.txt` with the full
timestamped transcription. *(Verified)*
