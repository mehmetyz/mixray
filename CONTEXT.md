# CONTEXT.md — project memory

Decisions and current state. The plan is in `SPEC.md`, the UI in `DESIGN.md`, the work in
`TASKS.md`. Update the "State" section when something changes.

## Scope

- Built for the Meta Global AI Developer Hackathon, which started Oct 26, 2026. Submission closes
  Nov 4, 2026.
- Problem statement: **Build for Your World.** Mixray is framed as a creative tool for musicians,
  not an education chatbot.

## Decisions (with reasons)

- **Name: Mixray** (= x-ray of the mix). Tagline: *Point at a sound. Hear it alone. Learn to play
  it.* Rejected names: Hookline (an existing music guessing game), Unravel, Decoda (an existing
  product with the same use case), Keyhook, Stemprint, Trackray.
- **Core flow:** add a song or a video scene → pick one sound with SAM (text prompt, Muse
  suggestion chip, or a tap on the video) → analyze it → learn it on a **keyboard only**. Any sound
  can be isolated, including a guitar riff, but it is always learned on keys; instrument-specific
  learning is a post-hackathon idea.
- **Routing is measured, not preferred** (`engine/fallback.py`): a solo recording is served
  unseparated; vocals, bass and guitar in a band go to SAM Audio `large` (spans, 8 draws, Judge pick),
  and to Demucs when every draw is empty; piano goes the same way (Nov 2), but its SAM Audio output is laid
  as a mask onto the real mix and its notes are read from the Demucs piano stem; organ, synth, strings, drums and
  speech go to Demucs;
  horn, footsteps, dog and siren go to SAM Audio with one draw. Notes are only claimed for vocals, bass,
  guitar and piano, or a solo recording. Level gates answer "not found" for an absent sound.
- **The user draws an area, on Add or Isolate.** Muse Spark names the crop and that name drives
  separation. **SAM 3.1** only draws the Track overlay switched on in Analyze (640 px, 5 fps, forward
  from the selected frame); the mask is never fed to SAM Audio, because the mask path measured an
  order of magnitude slower and leaked neighbouring sounds.
- **Clip ≤ 30 s** (≈ 16 bars at 128 BPM): enough for a hook, and it bounds the cost of every model
  call.
- **Upload goes straight to Modal**, with the audio trimmed in the browser first and a 7-day
  auto-delete. Vercel only hosts the UI and small API routes.
- **Rights:** demos use media we own, or third-party CC0 / CC BY / CC BY-SA media with full
  attribution. NC and ND licences are avoided. Every third-party file gets an entry in `CREDITS.md`
  (title, author, source URL, licence, changes made) and an on-screen credit where it plays. No film
  scenes and no commercial songs anywhere. The upload screen has a rights checkbox.
  - **A CC licence on a recording does not cover the music performed in it.** For a video of someone
    playing, the uploader licensed their footage, not the composition. Such a clip is only used
    publicly when the piece is public domain or the performer's own work. CC BY-SA also pulls a
    derived demo video into ShareAlike; plain CC BY / CC0 does not.
- **Stack:** monorepo, `apps/web` Next.js (App Router, TS, Tailwind, pnpm) on Vercel; `engine/`
  Python 3.11 on Modal (one image per heavy model); `schema/trackmap.schema.json` v2 is the only
  contract.
- **Look:** quiet monochrome DAW, one surgical accent. See `DESIGN.md`, which is authoritative.
- **Live URL:** https://mixray.vercel.app. A custom domain is optional; this URL is enough.
- **Contributor mode everywhere** (`muse-spark-1.2-contributor` for audio): far cheaper at the same
  quality for this workload. Requests may be used to improve the models, so the Add screen discloses
  this next to the rights checkbox.
- **`recipe` runs on Muse Spark Open via Baseten partner inference.** The model is an 816B
  mixture-of-experts; self-hosting it is not possible within this project's budget.
- Modal CLI on macOS needs `MODAL_DISABLE_API_PROXY=1` to connect.

## State

- Done: plan, spec, design spec, task list, schema v2, mock trackmap (validated).
- Done (Oct 26): repo setup; web scaffold (pnpm workspace, Next 16.4.3, Tailwind 4, strict TS,
  trackmap types generated from the schema, Ajv validation); engine scaffold; Meta API reference in
  `SPEC.md` §9.
- Done (Oct 27): SAM Audio runs on Modal. Passing `visual_ranker=None, text_ranker=None,
  span_predictor=None` (with the default `strict=True` — **never** `strict=False`, because
  `SAMAudio.load_state_dict` has `if strict:` with no `else:` branch and silently skips loading
  `checkpoint.pt`) drops the unused ranker stack at load time: `facebook/sam-audio-small` in `fp32`
  uses 5.56 GB idle / **14.26 GB peak VRAM** on a 24 GB GPU and separates a 30 s clip in **5.1 s**
  (12.1 s warm load from the weights Volume).
- Done (Oct 27): engine implementation — `POST /jobs` (multipart upload ≤ 50 MB, ≤ 6 min, `ffmpeg`
  trim ≤ 30 s to 48 kHz WAV + MP3, SHA-256 clip id, 720p video copy + 10 fps frames, schema-v2
  `TrackMap`), `POST /jobs/{id}/isolate` (SAM Audio GPU worker + SHA-256 `(clip, prompt)` cache),
  `GET /jobs/{id}`, `GET /files/{path}`, CORS, per-IP daily quota, and a daily 7-day cleanup.
- Done (Oct 28): all five screens implemented against the design spec, with a persistent transport
  bar, dynamic trackmap loading from Modal, in-browser WAV trimming, canvas waveforms and piano
  roll, QWERTY + Web MIDI keyboard, the coach tool handler, and zero-dependency `.mid` + `.zip`
  export.
- Done (Oct 28): resolved a Modal container crash loop on `api()` caused by FastAPI trying to build
  Pydantic response models for a `FileResponse | JSONResponse` union; fixed with
  `response_class=Response`. Verified the deployed chain end to end.
- Done (Oct 28): isolation sounded weak because of configuration, not the weights:
  `reranking_candidates=1` returns a single unjudged sample, and the released config leaves
  `text_ranker=None`, so reranking is a no-op even if candidates are raised. `sam-audio-base` scores
  below `-small` on music in Meta's own table and is ruled out.
- Done (Oct 28): MIDI library unifying Web MIDI, the on-screen keyboard and QWERTY into one note
  stream aligned to the audio clock, with take recording and a fixture suite.
- Done (Oct 30): a tap on a video frame goes to SAM 3.1 for masks, the masked region is cropped and
  named by Muse Spark, and that name drives the fast text separation. Segmentation alone costs about
  110 s for 270 frames, so the UI shows progress. Tracks are served under `video.tracks`.
- Done (Oct 30): `/api/coach` accepted live. Muse Spark gets the per-bar score the browser computed
  plus the notes being learned, and answers through the five fixed tools; every tool call is
  validated at the boundary. Audio is deliberately not sent.
- Done (Oct 30): `recipe` accepted live on Baseten. Verified shape: `POST
  https://inference.baseten.co/v1/chat/completions`, OpenAI chat-completions format, model slug
  `meta-models/muse-spark-open-1026`. **Muse Spark Open accepts `json_schema` but does not enforce
  it**, so the reply is validated and retried, never trusted. `n > 1` returns HTTP 400.
- Done (Oct 30): push-to-talk voice commands run on Muse Voice Transcribe. The endpoint needs a JSON
  `request` part beside the `audio` part, and it writes numbers as words, so the command parser reads
  spoken numbers.
- Done (Nov 1): routing above, area selection on Add and Isolate, and the Track toggle in Analyze.
  Checked on a dev server. Production still runs the older engine, and the area and Track UI has not been run
  in a browser against the new engine.
- Measured (Nov 1), 50 ms note F1: solo guitar 0.87, band vocals/bass/guitar SAM Audio 0.68 against Demucs 0.71
  (n=7). Tempo is right on 7/12 clips, key on 5/12.
- Run the engine checks with `uv run --all-groups`, because `numpy` comes from those.
- Done (Nov 1): keys play the selected sound itself, at the pitch heard in the track, with a synth only as
  fallback; the take score keeps the latest pass over each moment and ignores keys pressed while paused; voice
  listens continuously through Muse Voice Transcribe, with the browser's speech service removed. Verified by
  fixtures, pitch measured on a test tone in a browser, and a spoken phrase through the gate, transcription and
  parser. Not yet run with a real microphone in the app or with the Launchkey.
- Done (Nov 1): bar lines come from how well each bar fits one chord, and chord names use the bass on the
  first beat; on a test clip with known notes bars went from a beat off to correct and chords reached 6 of 7
  exact, measured on one clip and shifted versions of it. The easy part no longer stacks notes on one slot.
- Done (Nov 1): every screen was cut down to what is real for the clip. Removed the demo link, invented labels
  and fixed durations; the Add screen now states contributor mode. Notes arrive after the sound is playable, so
  the client waits for them. The demo route still exists, unlinked, and holds no real audio.
- Done (Nov 1): voice no longer listens all the time. A sustain pedal, any drum pad or a control the player
  chooses (also `V` and a button) opens the microphone for one phrase and turns the track down. Meta has no
  text-to-speech, so replies are a short sound and a line on screen; the system voice is gone. About 40 phrases
  now drive playback, bars, loops, tempo, what is heard, part, sound, screen and octave. Run in a browser with a
  fake microphone and fake MIDI input, spoken phrases going through Muse Voice Transcribe. Not yet run with a
  real microphone or the Launchkey, whose pads must be in Drum mode for the default to match.
- Done (Nov 1): `/` lists the clips this browser added (localStorage only, no database), and Add opens the studio
  before the separation ends; Isolate resumes its progress after a reload. Verified in a browser.
- Done (Nov 2): the "Synth lead, Piano, Bass, Drums" chips were an ingest placeholder left whenever Muse
  Spark refused to hear the clip, which happened on three of four uploads. Chips now come only from Muse:
  video clips are described from the real video, empty replies are retried, one chip is enough (requiring
  three produced "fallback dummy"), and one instrument under several names becomes one chip. Deployed and
  checked on five demo clips.
- Done (Nov 2): steam over a café piano passed the solo test and was served as piano. The test now also
  weighs high frequencies; that clip goes to the Demucs piano stem. The web retries dropped status polls
  instead of failing a long separation with "Failed to fetch", and reads a clip's state from the engine.
- Open: whether vocals, bass and guitar should default to Demucs. SAM Audio does not beat it on notes
  and returned only empty draws on a real guitar video; `AGENTS.md` and `SPEC.md` still call Demucs a
  fallback. Tempo and key accuracy; a full isolation takes up to about 5 minutes; drum hits to pads are
  measured for kick only and not built.
- Done (Nov 2): six demos on the home page, as shortcuts: a card opens Add with its video from
  `apps/web/public/demos` already chosen and its sound typed in; the user can change the name, the sound
  or draw an area, and Continue runs the real pipeline. Add also gained a project name field. Five were generated in Google Flow (labelled AI-generated, watermark burned in) and one
  is a real public-domain U.S. Navy Band recording. Most are generated because an open licence on a video
  of musicians rarely covers the music they play; `CREDITS.md` has the details.
- Measured (Nov 2), piano note decoding, 50 ms note F1: 20 public-domain pieces from Mutopia rendered with the
  Salamander grand piano samples, with a generated bass and drums or steam-like noise; tuned on 10, reported once
  on the other 10. Onset threshold 0.6 and no melodia trick beat the old values in a band (0.683 to 0.751), under
  steam (0.753 to 0.824) and solo (0.791 to 0.885), on all 10 pieces in a band. Applied to piano only. The rendered
  test material is easier than a real band, so these are not real-recording scores.
- Done (Nov 2, deployed): piano through SAM Audio masked onto the mix, notes from the Demucs stem with the new
  decoder. On the café demo steam fell from 20.2 to 11.8 and the off-beat note starts from 8 to 1, with the same 14
  of 16 beats found. Results from an older isolation version are no longer listed, so a version bump clears a clip's
  sounds until they are separated again.
- Done (Nov 2): state audit in a browser. Fixed: the Coach failed on every request (notes sent in units the route
  refused, and the route's answer parsed as a raw model reply); Play was silent until a first sound existed; playback
  stopped when notes arrived or a sound was switched; Play after the end of a clip stopped at once; a loop reaching
  the clip's end stopped; video ran at full speed under a slowed track; Track state leaked between sounds. Run with
  scripted checks on Play, Pause, Space, screen changes, rate, loop, area, Track on both screens, Practice, Coach and
  Export. Not yet run with a real microphone or the Launchkey.
- Done (Nov 2): tests and CI. `engine/tests` (pytest, with real ffmpeg and librosa, no model or network) and
  `apps/web/tests` (`node --test` through `tests/setup.ts`, which resolves `@/` and extensionless imports) beside the
  older fixtures. `.github/workflows/ci.yml` runs lint, types, tests and build. README gained the evaluation table and
  setup; `CREDITS.md` lists the evaluation data.
- Done (Nov 2): `evaluation/` holds the Colab work by topic with its output, limited to data with a clear licence.
  Run again: piano and guitar decoding, and eight SAM Audio draws on an A100 with the same seeds. All gave the Nov 1
  figures, except CLAP (0.440 to 0.450), which scores a random crop. Stored outputs for the gate and solo guitar were
  re-scored with the same figures. Also added: MIT licence.
- Open: note accuracy on a real recording with known notes; nobody on the team plays, so it needs a labelled
  recording with clean rights.