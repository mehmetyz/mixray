# Architecture

Mixray is two deployables and one contract.

```
apps/web/      Next.js (App Router, TypeScript, Tailwind) on Vercel
               UI, Web Audio, Web MIDI, canvas rendering, and three server routes
engine/        Python 3.11 on Modal
               ingest, separation, analysis, transcription, arrangement, recipe
schema/trackmap.schema.json
               the only contract between the two; TypeScript types are generated from it
```

The browser never holds a model key. Every model call goes through a Next.js server route or
through Modal, and both validate what comes back before it reaches the UI.

## The chain

```
upload → analyze → isolate → transcribe → arrange → learn
```

1. **Upload.** The browser trims the clip, then posts it straight to Modal. `ffmpeg` cuts it to at
   most 30 s, normalises it to 48 kHz WAV plus an MP3 for playback, and, for video, writes a 720p
   copy and 10 fps frames. The clip id is the SHA-256 of the audio, so the same file never
   processes twice and regenerated audio can never collide with an old cache entry.
2. **Analyze.** Tempo, beat grid, downbeats, bars, chords, key and sections, from `librosa`
   features. Tempo is not read from a single estimator: candidate grids are proposed by several
   estimators, scored against the onset envelope under a tempo prior, and the winner reports a
   confidence derived from its margin over the runner-up.
3. **Isolate.** SAM Audio separates the sound the user asked for. Demucs is a fallback for the six
   standard stems, and the UI can switch between them.
4. **Transcribe.** Basic Pitch turns the isolated sound into notes, which are snapped to the beat
   grid from step 2 rather than to a second, independently estimated tempo.
5. **Arrange.** The notes become an easy single-voice part and an intermediate two-hand part, using
   the chords from step 2 for the left hand.
6. **Learn.** The browser scores the take per bar against the arrangement, and Muse Spark turns
   that score into coaching through five fixed tools: `set_tempo`, `set_loop`, `mark_problem_bar`,
   `simplify_bar`, `switch_hand`. Every tool call is validated at the boundary — an unknown name, a
   bar outside the piece or an out-of-range value is dropped, never applied.

## Engine HTTP surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness |
| POST | `/jobs` | multipart upload, returns the clip id and its trackmap URL |
| POST | `/jobs/{id}/isolate` | separate one prompted sound |
| POST | `/jobs/{id}/track` | name an area drawn on a video frame, then isolate that sound |
| POST | `/jobs/{id}/tracks/{track}/follow` | follow a named area through the clip with SAM 3.1 |
| GET | `/jobs/{id}` | job state |
| GET | `/files/{path}` | serve a produced file |

Requests carry a signed token minted by the web app, so the shared engine key never reaches the
browser.

## Why each model is where it is

- **SAM Audio** runs self-hosted on Modal (`facebook/sam-audio-small`, fp32, 24 GB GPU). The
  auxiliary ranker stack is left unloaded at `from_pretrained` time, which drops roughly 7 GB of
  weights that only matter when drawing multiple candidates; a 30 s clip then separates in about
  5 s at a 14.3 GB peak.
- **Area selection:** the area drawn on a frame is cropped and named by Muse Spark, and that **name**
  drives separation. **SAM 3.1** only draws the on-demand Track overlay, at 640 px and 5 fps; a mask
  is never fed to SAM Audio, because that path measured an order of magnitude slower and leaked
  neighbouring sounds.
- **Muse Spark** gets the audio for suggestions and summaries, and the computed per-bar score for
  coaching. It is never asked to invent a number: every figure in a summary is checked against the
  analysis before it is shown.
- **Muse Spark Open** runs on Baseten partner inference, because an 816B mixture-of-experts model
  cannot be self-hosted inside this project's budget. It accepts a JSON schema but does not
  enforce one, so its reply is validated and retried rather than trusted.
- **Muse Voice Transcribe** takes a 16 kHz mono WAV from push-to-talk. It writes numbers as words,
  so the command parser reads spoken numbers.

## Producers never share a file

Each producer writes its own sidecar — `isolation.json`, `transcription.json`, `recipe.json`,
`summary.json` — and the served trackmap is assembled on read. Nothing mutates a shared
`trackmap.json`, which is what makes the follow-up workers safe to run concurrently.

Two ordering rules the hard way: a Modal Volume must be committed **before** work that reads it is
queued, because followers reload the Volume as they start; and JSON served from the Volume is
reloaded and sent uncached, because a sidecar that arrives a second later must not be hidden by a
stale read.

## Cost and abuse guards

Clip at most 30 s, upload at most 50 MB, source at most 6 minutes, video frames capped at 300 at
10 fps, content-addressed caching on both uploads and isolations, a per-IP daily quota on clips and
isolations, every Modal function with an explicit timeout and the smallest GPU that works, and a
daily job that deletes anything older than 7 days.
