# Transcribe - paste a Facebook Reel (or any video), get the full text

A small, self-contained tool in this repo. Paste a Facebook Reel / Facebook
video / YouTube link - or a whole shared message - or upload an audio/video
file. You get:

- the **full transcription** on screen, with timestamps
- a **Save as text** button that downloads it as a `.txt`
- optionally, an AI **explanation**: what it is, a summary, key points with
  timestamps, a walkthrough, topics, and takeaways

Transcription runs **locally** on your machine (faster-whisper on CPU). Only the
optional explanation calls out to Google. No account, no credit card, no Vercel.

It is Python and lives beside the TypeScript app, so it does not affect
`npm run lint`, `npm run build`, or `npm test`.

---

## Everything about Facebook links

Facebook gives you a different-looking link depending on where you tap Copy.
**All of these work.** You do not have to clean the link up - the tool pulls the
URL out of whatever you paste and strips the tracking junk for you.

| What you copied | Example | Works? |
| --- | --- | --- |
| Reel link | `https://www.facebook.com/reel/123456789` | yes |
| Watch link | `https://www.facebook.com/watch/?v=123456789` | yes |
| Mobile link | `https://m.facebook.com/watch/?v=123456789` | yes |
| Desktop link | `https://web.facebook.com/reel/123456789` | yes |
| Short link | `https://fb.watch/abcDEF/` | yes |
| With tracking junk | `...?mibextid=ZbWKwL` or `...&__cft__[0]=...` | yes - stripped |
| No `https://` | `facebook.com/reel/123456789` | yes |
| Whole shared message | `Check this out https://www.facebook.com/reel/123 see it` | yes - URL pulled out |

**How to copy a Facebook Reel link (phone or desktop):**

1. Open the reel.
2. Tap **Share**, then **Copy link**. (On desktop, right-click the video and
   choose **Copy link**, or use the timestamp menu.)
3. Paste it straight into the box below. No editing needed.

Verified 2026-10-31: all five hostname forms above were resolved by the
downloader, and a messy mobile link with tracking params produced a full
transcript and explanation. *(Verified)*

---

## Run it - step by step

### 0. Prerequisites

- **Python 3.10 or newer** - check with `python3 --version`. Tested on 3.13.
- **About 1 GB of free disk** for the Whisper speech model. It downloads once,
  on the first transcription, then is cached.
- Internet access, to fetch the video and (if used) the AI explanation.
- You do **not** need to install `ffmpeg` - a static build comes from
  `imageio-ffmpeg`, installed in step 2.

### 1. Get the files

If you already have this repo, you have them:

```bash
cd tools/transcribe
```

### 2. Install the dependencies (one command)

```bash
python3 -m pip install -r requirements.txt
```

That installs four things: `yt-dlp` (downloads the video), `faster-whisper`
(the speech-to-text engine), `imageio-ffmpeg` (the audio decoder), and `numpy`.

### 3. (Optional) Add a free Google key for the AI explanation

Without a key you still get the **full transcript** - only the explanation
section is hidden. To enable it:

1. Open <https://aistudio.google.com/apikey> and create a free API key.
   The free tier needs **no credit card** (see <https://ai.google.dev/pricing>).
2. In the same terminal you will run the app from, set it:

```bash
export OHGeminiAPI=your_key_here      # macOS / Linux
# set OHGeminiAPI=your_key_here       # Windows PowerShell
# set OHGeminiAPI=your_key_here       # Windows cmd
```

The name matters: it must be `OHGeminiAPI` (or `GEMINI_API_KEY`) and it must be
set in the *same* terminal that runs the app.

### 4. Run it - pick one

#### Option A - the web app (this is the one with the "Save as text" button)

```bash
PORT=8000 python3 webapp.py
```

Then open <http://localhost:8000> in your browser and:

1. Paste a Facebook Reel link (or a whole shared message) in the box - or
   choose an audio/video file instead.
2. Pick a **Model** if you like: `tiny` is fastest, `base` is the default,
   `small` is more accurate, `medium` is slow. Leave **Language** on
   auto-detect unless the result looks wrong.
3. Press **Transcribe**. The first run downloads the model, so it is slower;
   after that it is quick.
4. Read the full transcription. Click **Save as text** to download
   `<title>.transcript.txt`, or **Copy** to put it on the clipboard.

If port 8000 is busy, use another: `PORT=8080 python3 webapp.py`.

#### Option B - the command line

```bash
python3 vtx.py "https://www.facebook.com/reel/123456789"
```

It writes two files into `./out/`:

- `<slug>.transcript.txt` - the timestamped transcript
- `<slug>.md` - the transcript plus the AI explanation

Useful options:

| Option | What it does |
| --- | --- |
| `--out DIR` | Write the files somewhere else |
| `--model tiny\|base\|small\|medium\|large-v3` | Accuracy vs speed (default `small`) |
| `--lang en\|ar\|fr\|auto` | Force a language instead of auto-detect |
| `--no-ai` | Transcript only, skip the explanation |
| `--cookies cookies.txt` | For login-only or rate-limited videos |

---

## Troubleshooting

**The first transcription is very slow.**
That is the one-time model download (about 1 GB for `small`). Later runs reuse it.

**"ffmpeg not found".**
Run `python3 -m pip install imageio-ffmpeg` and try again.

**No explanation appears.**
`OHGeminiAPI` is not set in the terminal that is running the app. Export it
(step 3) and restart the command. The app logs `[explain] skipped` when the key
is missing, so you can tell the difference between "no key" and "the call failed".

**A Facebook link does not work.**
Check that the post is public. Private posts, friends-only posts, and Stories
need login - use `--cookies cookies.txt` exported from a logged-in browser.

**YouTube says 403 / blocked.**
YouTube blocks datacenter and VPN IP addresses. It works from a home connection.
You can also add `--cookies cookies.txt`.
`operator:` the web app does not expose cookies yet; the command line does.

**"Transcription failed" with no detail.**
Run the same link through Option B - the command line prints each step, so the
error is visible.

---

## Notes and limits

- Transcriptions run one at a time, because the speech model is memory-hungry.
- `medium` and `large-v3` are slow on CPU. Start with `base` or `small`.
- The Gemini free tier is rate-limited; for large batches, add a short pause.
- Cost: **$0**. Transcription is local; the explanation uses Google's free tier
  (<https://ai.google.dev/pricing>, no card). `yt-dlp` is public domain and
  `faster-whisper` is MIT.
