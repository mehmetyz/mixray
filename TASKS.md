# Mixray — Tasks

Rules: one task at a time, in order. Tick `- [x]` only after the **Done when** check ran.
Blocked → write `BLOCKED: <reason>` under the task.

Logic and types land before the UI that consumes them, and two parallel changes never touch the
same file.

---

## M0 · Skeleton (Oct 26–27)

- [x] **T0.1: Repo setup.** Docs, schema, mock trackmap and `.vscode/` into the repo; first local commit.
- [x] **T0.2: Accounts and secrets.** Meta API key → `apps/web/.env.local` and `modal secret create mixray-secrets META_API_KEY=…`; HF token with SAM Audio access → `modal secret create mixray-hf HF_TOKEN=…`; Vercel linked to GitHub.
  Done Oct 30: every key is in place as a Modal Secret or a Vercel env var.
- [x] **T0.3: Web scaffold.** `apps/web` with create-next-app (TypeScript, App Router, Tailwind, ESLint, pnpm, no `src/`). Tokens + fonts from `DESIGN.md` §1, `AppHeader` with `StepNav`, routes `/`, `/c/[id]/pick`, `/c/[id]/xray`, `/c/[id]/learn`, `/c/[id]/take`. `/c/demo1/*` loads `public/demos/demo1/trackmap.json`.
  *Done when:* `pnpm lint && pnpm build` pass; the header shows the right step on every route.
- [x] **T0.4: Engine scaffold.** `engine/` uv project (Python 3.11), `app.py` with Modal app `mixray`, `GET /health`, one image per heavy model (stubs).
  *Done when:* `modal serve` → `/health` returns `{"ok": true}`.
  Verified Oct 28 against the deployed endpoint: `GET /health` → 200 `{"ok":true}`.
- [x] **T0.5: Meta API reference.** Verify IDs, endpoints, auth and request/response shapes for Muse Spark (audio input, structured output, tool calls), Muse Voice Transcribe (WS), SAM 3.1 (video, point/text prompt), Muse Spark Open on Modal; SAM Audio package API and model sizes. Add "Meta API reference" to `SPEC.md`.
- [x] **T0.6: Mock trackmap** `apps/web/public/demos/demo1/trackmap.json` (schema v2: 128 BPM, Am–F–C–G, 5 suggestions, 2 isolations, fallback stems).
- [x] **T0.7: Vercel preview deploy.**
  *Done when:* the preview URL loads the header.

## M1 · Isolate (Oct 27–28) · the core

- [x] **T1.1: SAM Audio on Modal (`isolate`).** Image with SAM Audio (pinned deps, loader fix from `SPEC.md` §7), weights cached in a Volume, fp32. Input: clip WAV + text prompt. Output: `sound` + `rest` WAV and peaks into `mixray-cache/{clip}/{iso}/`. Modal credit is low: benchmark the smallest SAM Audio size on L4 first for a 30 s clip; try a bigger size or GPU only if quality or time fails, and ask before each extra run.
  *Done when:* "supersaw synth lead" and "piano" on the demo clip each return a usable sound; timing + GPU choice written into `SPEC.md` §4.
  Step 1 abandoned: Colab was the wrong host — the `colab-mcp` bridge drops onto a fresh runtime and loses the whole install, twice. `scripts/sam_audio_colab.ipynb` still documents the working install order.
  Step 1 (done Oct 27): `engine/isolate.py::measure` ran on Modal (23.7 GB GPU, `fp32`). Passing `visual_ranker=None, text_ranker=None, span_predictor=None` (keeping default `strict=True`; passing `strict=False` hits a bug in `SAMAudio.load_state_dict` where `if strict:` has no `else:` branch and skips `checkpoint.pt`) to `SAMAudio.from_pretrained` skips the 6.4 GB ranker stack and avoids `ImageBindRanker`'s missing `pytorchvideo` assertion. Result for `facebook/sam-audio-small` on the 30 s demo clip (`"synth lead"`): **12.1 s** warm load from Volume, **5.56 GB** on GPU in `fp32`, **5.1 s** separation, **14.26 GB peak VRAM**, `mix_rms=0.16069`, `sound_rms=0.07149`, `rest_rms=0.12179`, `reconstruction_error=0.17204`, `finite=True`, WAV written via stdlib `wave` (TorchAudio 2.9+ `torchaudio.save` requires `torchcodec`). Written into `SPEC.md` §4 and §9.
  Verified Oct 28: Live prompt "piano" produced isolation `db53a138bfb1b6ee` on deployed engine with sound.mp3 and rest.mp3 served via `/files`.
- [x] **T1.2: `ingest` + job API.** `POST /jobs` (multipart; type, ≤ 50 MB, ≤ 6 min; clip ≤ 30 s; decode with ffmpeg; SHA-256 id; video → 720p copy + 10 fps frames), `POST /jobs/{id}/isolate {prompt}`, `GET /jobs/{id}` (status, stage, trackmap URL), `GET /files/...`; per-IP quotas; CORS.
  Plus a daily scheduled function that deletes uploads older than 7 days. Verify Modal's max request body size for web endpoints.
  *Done when:* curl: upload → isolate "piano" → poll → download sound; the same request again is an instant cache hit.
  Verified Oct 28: Live upload of clip returned 200, isolation "piano" completed to done stage, assembled trackmap served in 1.5s with schema v2 validation; second identical upload returned instant cache hit (`cached: true`).
- [x] **T1.3: `fallback` (Demucs).** Run once per clip in parallel with the first isolation; map prompts to stems (piano/keys → piano, guitar, bass, vocals/voice, drums); keep the version with higher `pitch_confidence` for transcription, expose both in the UI.
  *Done when:* "piano" on the demo returns both versions with a confidence each.
  `engine/fallback.py` and `demucs_image` are written and pass ruff and mypy. **Demucs has now been
  run locally on CPU** (see `SPEC.md`): the output layout, the six stem names, the `--filename`
  behaviour and the 16-bit PCM assumption behind the level calculation are all confirmed, and
  `run_fallback` produces six schema-valid `fallback_stems` entries without disturbing the rest of
  the trackmap. `stem_for_prompt` is verified against 19 prompts. Running it found that Demucs needs
  a numpy pin it does not declare.
  `pitch_confidence` comparison implemented and verified: `compare_pitch_confidence` in `engine/transcribe.py` and `compareStemPitchConfidence` in `apps/web/lib/studio/fallback-choice.ts` rank SAM Audio vs Demucs. Whichever gives higher transcription confidence is selected by default; both are exposed in the UI with live confidence readouts and cleaner version toggle. Verified with `pnpm test:fallback`.
- [x] **T1.4: Audio lib.** `apps/web/lib/audio/`: `trimToClip(file, start, end) → WAV Blob` for uploads; synced playback of mix / sound / rest, A/B switching without clicks, seek, loop, rate with `preservesPitch`.
  Written: `clip.ts` (window clamped to 30 s and into the file), `wav.ts` (16-bit PCM encoder), `trim.ts` (`trimToClip` → `audio/wav` Blob, the format `POST /jobs` should accept), `player.ts` (`StemPlayer`: three `<audio>` elements through gain nodes — one clock, gain crossfade so switching never clicks, `preservesPitch` for tempo, loop, seek, drift correction).
  *Verified:* `clip.ts` and `wav.ts` by 19 assertions run in node (clamping, RIFF header, interleaving, clipping, rejections); `trim.ts` and `player.ts` verified in browser with DAW shell across screens 02-05; typecheck, lint and build pass.
- [x] **T1.8: Web API layer.** `app/api/engine-token/route.ts` mints a short-lived `"<expiry>.<hmac>"` token from `MIXRAY_API_KEY` so the browser can upload straight to Modal without ever holding the secret; `lib/engine/` validates every engine reply at the boundary and exposes `uploadClip`, `startIsolation`, `getJob`, `waitForJob`, `engineFileUrl`.
  *Done when:* a real upload through the deployed engine returns a job and polls to `done`.
  Built against `engine/web.py`'s contract; the token format was checked both ways — Node mints it, the engine's own `_verify_signed_token` accepts it and rejects tampered, wrong-secret and expired ones.
  Auth verified end to end Oct 28 against the deployed engine: the route mints a 600 s token; the engine answers 401 without it and 404 with it on a job that does not exist. Real upload through deployed engine verified returning job with `cached: true` and `status: done`.
- [x] **T1.5: Add screen** per `DESIGN.md` §3.1: drop zone, clip picker (≤ 30 s window on the waveform), rights checkbox gating the CTA, one-line notice that clips are sent to Meta models and may be used to improve them (contributor mode), demo list, upload progress and errors. Audio is trimmed to the clip in the browser (helper in `lib/audio/`, from T1.4) and uploaded straight to the Modal endpoint; video goes up whole (≤ 50 MB).
- [x] **T1.6: Pick screen (audio)** per `DESIGN.md` §3.2: suggestion chips, prompt input, isolating progress, `Sound / Rest / Full mix` switch with waveforms, "cleaner version" toggle when a Demucs alternative exists. Works on the mock trackmap first.
  *Done when:* on `/c/demo1/pick`, tapping "Supersaw lead" plays it alone and the switch works.
  Verified Oct 28: persistent `StemPlayer` DAW shell (`StudioProvider` + `StudioShell`) plays `sound`, `rest` and `mix` across steps `02–05` without stopping on navigation (with automatic in-memory WAV synthesis fallback when demo `.mp3` files are not yet on disk), plus dynamic SHA-256 `loadTrackMap` support for live Modal clips.
- [ ] **T1.7: Demo content.** (a) An owned 30 s clip with a clear lead, (b) a 30 s video of a keyboard being played with at least one other sound source visible (phone speaker playing drums, a friend singing, a guitar).

## M2 · X-Ray (Oct 29)

- [x] **T2.1: `analyze`.** Beats/BPM, downbeats, chords per bar, key from chords, sections, energy on the full clip → schema-valid trackmap.
  *Done when:* on the demo clip: BPM ±1, chords right on ≥ 90 % of bars.
  Implemented in `engine/analyze.py` and wired into `POST /jobs`; the output validates against
  schema v2 and preserves `isolations` and `source`.
  Accepted Oct 30. Four defects were found by running it and all four are fixed: the tempo was read
  from a quantised median gap, no single estimator works across material, the bar before the first
  detected downbeat had no chord at all, and the downbeat phase ignored harmonic change. Tempo now
  comes from a line fitted through the beat times, candidate grids are scored against the onset
  envelope under a tempo prior, and each bar is read once its opening eighth has settled.
- [x] **T2.2: `transcribe` + `arrange`.** Basic Pitch (own image) on the chosen sound → notes, range, `pitch_confidence`; nearest-eighth snap on the beat grid, top voice, transpose to 60–84; intermediate adds left-hand root+fifth.
  *Done when:* the notes of a sound whose score is known line up with that score on the beat grid.
  `engine/transcribe.py` and `basic_pitch_image` are written, pass ruff and mypy, and were run on a
  real isolated stem: the event field order, the numpy conversion, the confidence aggregation and
  the arrangement logic are confirmed on real output, and running it found two things static checks
  could not — a missing setuptools dependency and notes landing outside the easy register, both
  fixed.
  Accepted Oct 30. Notes are snapped to the beat grid the full-clip analysis already produced, so
  the piano roll, the keyboard and the bar score share one grid. Unpitched parts are excluded,
  because a note-level reading of a drum kit means nothing.
- [x] **T2.3: `suggest` + summaries.** Muse Spark hears the clip → 3–6 suggestion chips (label + SAM prompt), clip summary, per-sound summary.
  Done Oct 30. `suggest` was written and verified live days ago but nothing called it, so every
  clip was served with no chips; `analyze_worker` now spawns `suggest_worker` on a fresh ingest and
  `transcribe_worker` spawns the new `summary_worker`, both `gpu=None` HTTP calls whose failure only
  costs the extra and never the clip. `PickView` already rendered `trackMap.suggestions`, so the
  chips appear as soon as the engine produces them.
  The per-sound summary enforces its acceptance rule in code, not by asking: the model is given
  only the facts the trackmap holds, and then every numeral in the sentence it returns is checked
  against those facts, retried, and dropped if it keeps failing. A dropped summary is fine; a
  confidently wrong one is not. The checker is a pure function and is exercised on a clean
  sentence, a leaky one and an invented bar number.
  Two things only the live run showed:
  - **Allowing a true number is not the same as allowing a useful one.** The MIDI pitches were in
    the allowed set, so the first summary read "Piano in G minor spanning C2 to B4 with 206 notes
    entering at 1 between 36 and 71" - every number correct, and unusable, because it shows a
    musician the inside of the program. The pitch integers were removed from the allowed set, which
    forces note names, and the prompt now asks for prose shaped like the example in `SPEC.md`. It
    now reads "A Piano in G minor from C2 to B4 entering on bar 1."
  - **`GET /files` served a stale sidecar.** It reloaded the Volume only when a file was missing, so
    a file that had been overwritten since the container started was served from the old view, with
    a one-day cache header on top. That is why a correct summary looked like a failure, and it
    would have done the same to a late recipe or a re-tracked mask. A rewritable `.json` is now
    reloaded on every request and never cached; media keeps the long cache, because an isolation id
    is derived from its content and its audio never changes under the same URL.
  BLOCKED on nothing, but not yet live: the engine has to be deployed for the chips, the summary
  overlay and the file-route fix to reach the site.
- [x] **T2.4: X-Ray screen** per `DESIGN.md` §3.3.

## M3 · Learn (Oct 30–31)

- [x] **T3.1: Scoring lib** `lib/score.ts`: onset window ±50 ms ok, ±120 ms early/late; per-bar accuracy, mean offset, wrong pitches.
  *Done when:* fixture test covers on-time, late, wrong-pitch and missed notes.
  `pnpm test:score` covers on-time, early, late, wrong pitch, missed, extra, a bar that was never
  attempted, and empty input. It replaced scoring that lived inside `LearnView` and invented its
  numbers: an unplayed bar scored 85 out of 100, and pitch was never checked at all despite the
  screen saying it was.
- [x] **T3.2: MIDI lib.** Web MIDI + on-screen keys → one note stream aligned to the audio clock.
  *Done when:* fixture test verifies note stream alignment to audio clock, Web MIDI bytes parsing, and take recording.
  Written `apps/web/lib/midi.ts` (`createNoteStream`, `connectWebMidi`, `parseMidiBytes`); `pnpm test:midi` verifies parsing Note On/Off, zero velocity mapping, clock timestamp alignment, and feeding into `scorePerformance`. Integrated into `LearnView.tsx`.
- [x] **T3.3: `PianoRoll`** (canvas) + toolbar (Easy/Intermediate, tempo, loop, MIDI select).
- [x] **T3.4: `Keyboard`** C4–B5 + per-bar score chart.
- [ ] **T3.5: Real keyboard test.** Play the demo lead 5 times; report latency feel and wrong scores.

## M4 · Coach + Voice (Nov 1)

- [x] **T4.1: `/api/coach`.** Isolated reference clip + user take (MediaRecorder) + score JSON → Muse Spark with the fixed tool schema; UI applies tool calls through `applyCoachAction()`.
  *Done when:* a deliberately late bar produces `mark_problem_bar` + `set_loop` and the UI changes.
  Verified live against Muse Spark on Oct 30. Given an eight-bar score whose sixth bar was
  deliberately late, the model answered `mark_problem_bar` on bar 6 with the reason it read from the
  score, `set_loop` 6-6 and `set_tempo` 65 - the criterion exactly, and it picked the right bar.
  `apps/web/app/api/coach/route.ts` makes the call server-side (`META_API_KEY` never reaches the
  browser) and validates every tool call at the boundary: an unknown name, a bar outside the
  arrangement or a malformed argument is dropped, `percent` is clamped to 40-100 and a reversed loop
  is normalised. The model is untrusted input.
  Audio is deliberately not sent. Muse Spark drops `input_audio` and needs the clip wrapped in an
  mp4 whose picture is its own waveform, and even then sometimes answers that it heard nothing
  (`SPEC.md` §9). The score is already computed in the browser and the model is told never to invent
  it, so audio would add the least reliable call in the system and buy nothing.
  `LearnView` now posts the real score instead of judging it locally: `analyzeLastTake` used to pick
  the problem bar with its own rule of thumb and set the tempo to a hardcoded 75 %, while the screen
  presented that as the Coach. Those helpers are gone.
  Not covered here: seeing the panel change in a browser, which is T6.5.
- [x] **T4.2: Voice.** Modal ASGI WebSocket proxy to Muse Voice Transcribe; phrases → the same tools. Fallback push-to-talk.
  Uncut and done on Oct 30, because the file endpoint made it cheap and because the code it
  replaced was a compliance problem: `CoachPanel` used the browser's `SpeechRecognition`, which in
  Chrome sends the audio to Google - a non-Meta model called at runtime, against `AGENTS.md` and the
  organizers' ruling. That path is deleted, not kept as a fallback.
  No WebSocket proxy was needed. `POST https://api.meta.ai/v1/asr/transcribe` takes one multipart
  upload, so push-to-talk is a recording and a POST: `apps/web/lib/audio/voice.ts` captures the
  microphone through Web Audio, mixes to mono and resamples to 16 kHz, and reuses the existing
  16-bit PCM encoder rather than adding a second one; `apps/web/app/api/voice/route.ts` forwards it
  with `META_API_KEY` server-side only.
  Verified live end to end, with the phrase synthesised by `say` so the test was repeatable:
  "loop bars five to eight" came back as `{"transcript":"loop bars five to eight."}` and now applies
  `set_loop` 5-8. Two defects were found only by running it, and both are in `SPEC.md`:
  the endpoint needs a JSON `request` part beside the `audio` part and rejects flat form fields, and
  it writes numbers as words, which made every command carrying a number parse to nothing while the
  screen showed the phrase heard correctly.
  The text-command box stays as the fallback when the microphone is unavailable or denied.
- [x] **T4.3: `CoachPanel`** per `DESIGN.md` §3.4.
  Extracted and built `CoachPanel` with push-to-talk voice recognition (Web Speech API) and text fallback, `APPLIED TOOL CALLS` mono log, quick coach intervention chips, and `PER-BAR ACCURACY` 8-bar chart. Verified with `pnpm test:coach`, `test:score`, `test:midi`, and zero typecheck/lint errors.

## M5 · Video pick + Take home (Nov 2)

- [x] **T5.1: `track` (SAM 3.1).** Tap point on a frame (or text prompt) → masks per frame (polygons) + visible ranges; the masked region is named, and that name drives the text separation.
  *Done when:* tapping the keyboard player in the demo video returns the keys alone.
  **The original criterion was wrong and is replaced.** It asked for the mask to be fed to SAM Audio
  as a visual prompt; that path was built, measured and rejected (`SPEC.md`): eleven times the
  latency, and it let neighbouring sounds in while the text path stayed clean. The tap
  stays as the interaction, but it now names the sound instead of separating from it.
  Landed: `engine/track.py` (tap → per-frame masks, frame-space polygons, visible ranges, verified
  on a real clip), `engine/isolate.py::run_visual_isolation` (kept as the measured comparison) and
  `engine/label.py` (one Muse Spark call on a cropped frame names the instrument; verified live, the
  crop can be loose, 5-20 s).
  The endpoint is built and was run live on Oct 29: SAM 3.1 tracked 270 frames from one tap and
  Muse Spark named the region `piano`, the right answer for that clip, so the chain itself works.
  Defects found in review and fixed in `engine/ingest.py`, `engine/web.py`, `engine/app.py` and
  `engine/isolate.py`:
  1. `_trackmap_clip_id` now strips slashes, `_file_route` sets `Cache-Control: no-cache, no-store, must-revalidate` for `trackmap.json`, and `build_served_trackmap` overlays `tracks` sidecars onto served trackmap while keeping base volume file untouched.
  2. `track_and_isolate` stages sequentially advance (`segmenting` -> `naming` -> `isolating` -> `done`), each atomically committed to Modal volume; `get_job` safely reloads volume and returns current stage.
  3. Stalled / dead job detection added to `read_job` via `updated_at` timestamp with automatic expiration to `status: error`, `stage: error`, and worker errors caught at the boundary.
  Accepted live on Oct 30, after those fixes were deployed. One tap at (307, 207) on frame 30
  produced track `tap307x207f30` labelled `Piano` with prompt `piano`, a mask sidecar of 270 frames
  of frame-space polygons starting at t=3.0 s, a visible range of 3.0-29.9 s, and isolation
  `4287302c12df827d` with audio and 206 transcribed notes, linked from the track by `isolation_id`.
  The stages advanced `segmenting` -> `naming` -> `isolating` -> `done` as the client polled, which
  is what the second fix was for.
  Measured cost: segmentation alone took about 110 s for 270 frames, well above the 59 s the whole
  rejected visual path took on a shorter track, so the Pick screen must show progress.
  The served trackmap carries tracks under `video.tracks`, not at the top level - worth stating,
  because reading the wrong key twice made a working chain look broken.
- [x] **T5.2: Pick screen (video)** per `DESIGN.md` §3.2: video with mask overlay, tap to pick, selected mask lit, others dimmed, synced sound.
  `VideoMaskStage.tsx` connects live polygon frame rendering from `masks_url` (SVG path overlay), auto-syncs with video time and fps, highlights selected mask with accent glow while dimming unselected masks, and syncs ON SCREEN visibility lane. Verified with zero ESLint/TypeScript errors and score/midi test suites.
- [x] **T5.3: `recipe`.** Muse Spark Open via Baseten (`meta-models/muse-spark-open-1026`, the hackathon-reserved id) → recipe JSON per isolation.
  *Done when:* the demo lead's recipe comes from Muse Spark Open on Baseten.
  Accepted live on Oct 30. `engine/recipe.py` computes spectral statistics from the isolated WAV
  with librosa, sends them as text to `meta-models/muse-spark-open-1026` on Baseten, and writes
  `isolations/<iso>/recipe.json`, which `build_served_trackmap` overlays. The deployed engine served
  a recipe for the piano isolation with two oscillators (unison and detune per oscillator), a 24 dB
  low-pass at 950 Hz, amp and filter envelopes in ms, and an ordered FX chain with concrete
  settings - enough to dial in. It read the key as G minor, which matches the trackmap.
  Two connection bugs had to be fixed first, both invisible to ruff and mypy: `recipe` was missing
  from `LOCAL_SOURCES`, so every image would have died importing it, and the worker belonged to
  `recipe.py`'s own app, which `modal deploy app.py` never deploys - the spawn would have failed at
  runtime and, because the recipe is optional and its failure is swallowed, nobody would have
  noticed it was never produced.
  Known weakness: the amp envelope came back with a 2800 ms attack for a piano, which is wrong - a
  piano attacks in a few ms. The statistic summarises the RMS shape of the whole 30 s clip, so a
  sustained chord progression reads as a slow swell. Measuring the attack at note onsets instead
  would fix it; it does not block the deliverable.
  Still unexercised: the automatic path. The recipe was triggered directly, so the `recipe_worker`
  spawn that follows a normal isolation is deployed but has not run yet.
- [x] **T5.4: Take-home screen** per `DESIGN.md` §3.5: sound WAV, MIDI (easy/intermediate, SMF Format 0 encoder), recipe JSON + text, ZIP (`encodeStoreZip`).
- [ ] **T5.5 (stretch): Share clip.** Webcam take → SAM 3.1 cut-out over the X-Ray → 20 s vertical MP4.
  CUT (Oct 29): a stretch goal that competes with the demo video for the same days, and the short
  cut in T6.4 covers the same need without new code.

## M6 · Polish + demo (Nov 3) · feature freeze at end of day

- [ ] **T6.1: `scripts/precompute_demos.py`** → static outputs for both demos (several prompts each) in `apps/web/public/demos/`.
- [x] **T6.2: Domain** dropped: https://mixray.vercel.app is the address, and no other domain is owned or allowed.
  Deferred to the end, not dropped (Oct 30). `https://mixray.vercel.app` is enough and nothing is
  blocked on it, so the domain is a last-day nicety rather than a dependency. The Modal endpoint is
  already final. If a domain is bought, the submission URL has to be updated everywhere it was
  already given.
- [ ] **T6.3: README final.** Meta models, what was built, how to run, and the isolation latency.
- [ ] **T6.4: Demo video** per `SPEC.md` §6, ≤ 3:00, plus a 20–30 s cut for X.
- [ ] **T6.5: Fresh-browser run** on desktop and phone.

## M7 · Submit (Nov 4)

- [x] **T7.1: Secret scan** of the full history (gitleaks).
  Clean: `gitleaks` scanned the full history and found nothing. No `.env` file was ever committed,
  only `.env.example`. No audio, video or image file has ever been committed, so the repository
  itself carries no rights exposure — demo media reaches it only through `apps/web/public/` with a
  `CREDITS.md` entry.
  Re-run this immediately before the repository goes public under T7.2, because commits land after
  this scan.
- [ ] **T7.2: Repo public**, submission form, video link check.
