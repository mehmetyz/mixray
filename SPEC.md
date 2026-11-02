# Mixray — Product & Build Spec

> **Point at a sound. Hear it alone. Learn to play it.**
> Add a song or a scene, pick one sound in it (the synth lead, the piano, the guitarist on stage) with SAM, see what it is playing, and learn it on your keyboard with a coach that listens.

Read this file fully before any task. `AGENTS.md` has the working rules, `DESIGN.md` the UI, `TASKS.md` the work items.

---

## 0. Context and hard constraints

- **Event:** Meta Global AI Developer Hackathon (remote, Cerebral Valley). Indie Developer track, solo.
- **Hacking started:** Mon Oct 26, 2026.
- **Submission deadline:** Wed Nov 4, 9:00 PM ET. **Our target: submit the evening before.**
- **Deliverables:** public GitHub repo, a **3-minute demo video**, and a **live product** judges can use (judging Nov 5–8; keep it online through Nov 9).
- **Problem statement:** *Build for Your World.* A producer learning keys hears a lead or a hook they love, but cannot pull that one sound out of the mix, cannot tell what it plays, and cannot learn it.
- **Rules that shape the build:**
  - **New work only.** All code here is written during the hackathon.
  - **Rights.** Demos use only music and video we own (or clearly CC-licensed material). Users confirm they own or have the rights to what they upload. No film scenes or commercial songs in the repo, the demo video or the precomputed demos.
  - **Meta models at runtime.** Every model that reasons, listens, separates by prompt or segments video is a Meta model. Open-source signal tools (Demucs, Basic Pitch) are allowed (organizers confirmed) and stay in supporting roles.
  - Framing: a **creative tool for musicians**, not an "AI for Education chatbot".

## 1. What the build optimizes for

- **Reach.** Every musician has a sound they want to learn, and it works on your own tracks and
  your own videos rather than on a fixed catalogue.
- **Meta models doing the real work.** SAM Audio isolates any sound from a text or visual prompt;
  SAM 3.1 follows a selected area through the video; Muse Spark names it, listens, suggests, summarises
  and coaches through tool calls; Muse Voice Transcribe keeps both hands on the keys; Muse Spark
  Open writes the sound recipe.
- **Depth over surface.** Prompted separation with a measured fallback, a beat grid, chords,
  transcription, arrangement, deterministic scoring, caching and cost guards.
- **A demo that lands in twenty seconds.** Type "synth lead" and the lead plays alone; tap the
  keyboard player in a video and only the keys play.

## 2. Product

### User flow (this is also the demo)
1. **Add.** Drop an audio or video file you own (mp3/wav/mp4/mov, ≤ 6 min) and choose a **clip of up to 30 s**: the part with the sound you want (16 bars at 128 BPM). Demo clips are one click.
2. **Pick a sound.**
   - *Any clip:* Muse Spark listens and suggests what it hears as chips ("supersaw lead", "piano chords", "pluck", "sub bass", "vocal chop"). Tap a chip or type your own prompt.
   - *Video clip:* or drag over an instrument in the frame, on Add or Isolate. Muse Spark names the area and that name becomes the prompt. SAM 3.1 follows the area on demand from the Analyze screen.
   - SAM Audio returns **the sound** and **the rest of the mix**. Listen with `Sound / Rest / Full mix`. If the result is weak for a standard instrument, the Demucs stem is offered as "cleaner version".
3. **X-Ray.** For the picked sound: tempo, key, chords under it, its notes on a piano roll, its range, and a **sound recipe** (what synth/patch it is). One Muse sentence: *"A detuned supersaw lead in A minor, mostly eighth notes between A4 and E5, entering on bar 9."*
4. **Learn (keyboard).** Falling-notes / piano roll of the sound's part. *Easy* = melody in the right hand; *Intermediate* = plus left-hand root/fifth from the chords. Loop bars, slow down without pitch change, play on a MIDI keyboard (Web MIDI) or on-screen keys. Deterministic timing/pitch scoring.
5. **Coach.** After a take, Muse Spark gets the isolated reference, the user's take and the score diff, answers in plain words and **acts through tool calls** (`set_loop`, `set_tempo`, `switch_hand`, `simplify_bar`, `mark_problem_bar`). Voice: "slow it down", "loop bars 5 to 8".
6. **Take home.** Download the isolated sound (WAV), its MIDI (easy + intermediate), and the sound recipe (JSON + readable text) to rebuild it in a DAW.

### Out of scope
Accounts, database, payments, mobile app, guitar/drum learning (keyboard only), lyrics, full multi-stem mixer, real-time separation, sheet-music engraving, any copyrighted demo content.

## 3. Architecture

```
Browser (apps/web, Next.js on Vercel)                     Modal (engine/, Python, GPU)
 ├─ Add: upload + clip picker ── POST /jobs ──────────────▶ ingest: decode, trim ≤30 s, hash, video frames @10 fps
 ├─ Pick: chips / prompt / area ─ POST /jobs/{id}/isolate ─▶ suggest  (Muse Spark: what sounds are in the clip)
 │                                                          track    (SAM 3.1 via Meta API: area box → masks, on demand)
 │                                                          isolate  (SAM Audio: text or visual prompt → sound + rest)
 │                                                          fallback (Demucs htdemucs_6s for standard instruments)
 ├─ X-Ray ◀── trackmap.json ───────────────────────────────  analyze  (librosa: beats, key, chords on the full clip)
 │                                                          transcribe + arrange (Basic Pitch on the sound, beat grid)
 │                                                          recipe   (Muse Spark Open via Baseten)
 ├─ Learn: piano roll, Web MIDI, scoring (browser)
 ├─ Coach: /api/coach ──────── Meta Model API (Muse Spark: audio in, tool calls)
 └─ Voice: WS proxy (Modal) ── Muse Voice Transcribe
                               Modal Volume cache keyed by SHA-256(clip) + prompt
```

- **Contract:** `schema/trackmap.schema.json` is the only interface between engine and web. One clip has one trackmap; each picked sound is an entry in `isolations`.
- **Secrets:** `META_API_KEY` in Modal Secret `mixray-secrets` and Vercel env (server-only). The browser never calls the Meta API directly.
- **Upload path:** the browser uploads **directly to the Modal web endpoint**, never through Vercel (its functions cap request bodies at ~4.5 MB, whereas Modal `@modal.asgi_app()` supports streaming HTTP bodies up to 4 GiB). Audio is trimmed to the ≤ 30 s clip **in the browser** (decode → WAV) before upload, so only the clip leaves the device; video is uploaded as is (≤ 50 MB) and trimmed with ffmpeg on Modal. Files live in Modal Volume `mixray-cache` under unguessable ids, are served by `GET /files/...`, and a daily scheduled Modal function deletes uploads older than 7 days. Precomputed demos are static files on Vercel.
- **Async:** isolation takes seconds to a minute. `POST` returns a job; the UI polls and shows stage progress (`listening → isolating → analyzing`).
- **Dev compute:** GPU experiments and demo precompute run on Colab (L4, via the VS Code extension; notebooks end with `runtime.unassign()`), not on Modal. Modal GPU is only for live uploads.
- **Demos:** `scripts/precompute_demos.py` runs everything once (including several prompts per demo clip) and writes static files to `apps/web/public/demos/`, so demos are instant and free.

### Engine stages (Modal functions)
| Stage | Tool | Notes |
|---|---|---|
| ingest | ffmpeg | Decode, trim to ≤ 30 s, mono+stereo 48 kHz, SHA-256 id; for video also frames at 10 fps (≤ 300 frames) and a 720p web copy. |
| suggest | Muse Spark (audio in) | Returns 3–6 short sound labels usable as SAM Audio prompts. Structured output. |
| track | SAM 3.1 (Meta API) | Input: the box drawn on a frame, when Track is switched on. Output: per-frame masks (compact polygons) + visibility lane. Also drawn in the UI. |
| isolate | SAM Audio (Meta, open weights, on Modal GPU) | Text prompt or visual prompt (masks from `track`). Output: `sound` and `rest` WAV. fp32. Cache per (clip, prompt). |
| fallback | Demucs `htdemucs_6s` | Run once per clip in parallel; if the prompt maps to piano/guitar/bass/vocals/drums, offer that stem as an alternative and use whichever gives higher pitch confidence for transcription. |
| analyze | librosa | Beats + BPM, downbeats, chords per bar (chroma templates, per-bar vote), key from chords, energy, on the full clip. |
| transcribe | Basic Pitch | On the chosen sound; separate image (Python 3.11, numpy<2). |
| arrange | own code | Snap to the **nearest eighth on the detected beat grid**, top voice, transpose into MIDI 60–84 (easy); intermediate adds left-hand root+fifth per bar. |
| recipe | Muse Spark Open via Baseten | Sound clip + spectral stats → recipe JSON (oscillators, unison/detune, filter, envelopes, FX). Open-weight bonus. |

### Meta models used
| Model | Where | Purpose |
|---|---|---|
| SAM Audio (open weights) | `isolate` on Modal | Pull one sound out of the mix from a text or visual prompt. **Core feature.** |
| SAM 3.1 (Meta Model API) | `track` | Follow a selected area through a video → tracked masks drawn in the UI. |
| Muse Spark, audio-capable (Meta Model API) | `suggest`, summary, `/api/coach` | Hears the clip and suggests sounds; one-line X-Ray summary; coach feedback + tool calls. |
| Muse Voice Transcribe (realtime WS) | voice proxy | Hands-free practice commands. |
| Muse Spark Open (open weights, Baseten partner inference) | `recipe` | Sound recipe. 816B MoE, too large to self-host (see §9). |

Verify every model ID, endpoint and request format in the official docs before coding against it (see `TASKS.md` T0.5). Do not guess.

### Coach tool schema (fixed; do not rename)
```json
[
  {"name": "set_loop",         "args": {"start_bar": "int", "end_bar": "int"}},
  {"name": "set_tempo",        "args": {"percent": "int (40-100)"}},
  {"name": "switch_hand",      "args": {"hand": "right|left|both"}},
  {"name": "simplify_bar",     "args": {"bar": "int"}},
  {"name": "mark_problem_bar", "args": {"bar": "int", "reason": "string"}}
]
```
The score (hits, early/late ms, wrong pitches per bar) is computed in the browser and sent to the model. The model explains and chooses actions; it never invents the score.

## 4. Cost and abuse guards
- Clip ≤ 30 s; reject files > 50 MB or > 6 min; video frames capped at 300 (10 fps).
- Cache by SHA-256 of the clip (+ prompt for isolation); same input → no GPU run.
- Per-IP daily quota: 5 clips, 10 isolations.
- Modal: scale to zero, `timeout` on every function, 24 GB GPU (`L4` / `A10G`; measured Oct 27: `facebook/sam-audio-small` in `fp32` with rankers disabled peaks at 14.26 GB and separates a 30 s clip in 5.1 s), and a hard cost ceiling configured outside the repo. Meta API: spend notification at the credit amount.
- Demo clips are precomputed (zero runtime cost).

## 5. Milestones

| # | Target date | Milestone | Done when |
|---|---|---|---|
| M0 | Oct 26–27 | Skeleton | Web on Vercel, Modal app deploys, Meta API reference verified, mock trackmap drives the UI. |
| M1 | Oct 27–28 | **Isolate** | Upload a clip → type "synth lead" (or tap a chip) → hear the sound alone and the rest; Demucs fallback works; cache hit on repeat. |
| M2 | Oct 29 | X-Ray | Trackmap with tempo, key, chords, the sound's notes, Muse summary and suggestions; X-Ray screen renders it, and the notes line up with the beat grid. |
| M3 | Oct 30–31 | Learn | Piano roll, loop, slow-down, Web MIDI + on-screen keys, scoring, easy/intermediate. |
| M4 | Nov 1 | Coach + Voice | Muse Spark feedback with working tool calls; voice commands (or push-to-talk). |
| M5 | Nov 2 | Video pick + Take home | Tap the keyboard player in the demo video → only the keys; downloads; sound recipe from Muse Spark Open. |
| M6 | Nov 3 | Polish + demo | Precomputed demos, README, video recorded. **Feature freeze at end of day.** |
| M7 | Nov 4 | Submit | Repo public, secret scan clean, video link works, submission sent. |

Cut order if late: share clip → voice (keep push-to-talk) → recipe on Baseten (fall back to Muse Spark via the hosted API) → video tap for live uploads (keep the precomputed demo video) → intermediate arrangement. **Never cut:** pick a sound by text prompt, X-Ray, Learn, Coach.

## 6. Demo video (3:00)

| Time | Content |
|---|---|
| 0:00–0:15 | First person: "I make EDM and I'm learning keys. I hear a lead I love, but I can't pull it out of the mix." |
| 0:15–0:45 | Drop own track → Muse suggests "supersaw lead, piano chords, sub bass" → tap "supersaw lead" → **the lead plays alone**; toggle Rest / Full mix. |
| 0:45–1:05 | Own video: **tap the keyboard player → only the keys play**. |
| 1:05–1:30 | X-Ray of the lead: key, chords, notes, sound recipe. |
| 1:30–2:15 | Learn on the MIDI keyboard; coach hears bar 6 is late and **sets the loop and tempo itself**; voice "loop bars 5 to 8". |
| 2:15–2:40 | Take home: MIDI + recipe dropped into a synth, the lead rebuilt. |
| 2:40–3:00 | What was built during the hackathon, which Meta models, the live URL. |

## 7. Model and dependency lessons
- SAM Audio sounded weaker than Demucs on standard stems (piano/bass/vocals) but is the only option for arbitrary prompts ("supersaw lead", "pluck"). Hence prompt-first with a measured Demucs fallback.
- SAM Audio loader breaks with `huggingface_hub` 1.x (`proxies` / `resume_download` kwargs): pin a compatible `huggingface_hub` or wrap `_from_pretrained`.
- **Install recipe that resolves, measured on Colab (Python 3.13, torch 2.11+cu130, Oct 27):** `sam-audio` leaves four git dependencies unpinned, and installing them in sequence moves `numpy` and `protobuf` up and down until the `numpy` install is left mixed (`numpy.dtype size changed … Expected 96 from C header, got 88`, raised from `numpy/random/mtrand`). Order that works: pin `huggingface_hub<1.0`, then `dacvae`, `imagebind`, `laion-clap`, `perception_models`, `sam-audio`, then repair the pins last: `pip install --force-reinstall --no-cache-dir numpy==1.26.4` and `pip install transformers==4.57.1 huggingface_hub==0.36.2`, then **restart the interpreter** so the repaired `numpy` loads. End state: numpy 1.26.4 (`laion-clap` requires `<2`), protobuf 3.19.6 (`descript-audiotools` requires `<3.20`), transformers 4.57.1 (5.x demands `huggingface_hub>=1.31`, which breaks the loader). Colab's own tensorflow/jax/gradio then report conflicts; they are unused here. The Modal image must bake this order rather than resolve it at runtime.
- **Colab fights back, Modal does not.** After the pins above, `import sam_audio` still failed twice on Colab's own preinstalled stack: `transformers.image_transforms` opportunistically imports TensorFlow (whose generated protobuf stubs need protobuf >= 5, while `descript-audiotools` holds 3.19.6) and then jax (which needs numpy >= 2.1 for `np.dtypes.StringDType`). Workarounds: `USE_TF=0`/`USE_FLAX=0` before the first transformers import, or uninstall `tensorflow jax jaxlib flax`. A Modal image built from scratch on Python 3.11 has none of these packages, so it avoids the whole class of conflict — prefer it over Colab for SAM Audio.
- **Modal's own client collides with the same protobuf pin.** `descript-audiotools` holds protobuf at 3.19.6, and the Modal client injected into the container crashes on import with `AttributeError: Enum VolumeFsVersion has no value defined for name 'ValueType'` — `EnumTypeWrapper.ValueType` first appears in protobuf 3.20, although modal declares only `protobuf>=3.19`. Pin `protobuf==3.20.3` as the last install: it has `ValueType`, still emits 3.x-compatible generated code so the audio stack's old `_pb2.py` files keep importing, and only tensorboard training logs ever wanted `<3.20`.
- SAM Audio high-quality reranking failed in bf16; run fp32.
- SAM Audio visual prompts need masks shaped `(N, 1, H, W)` bool.
- SAM Audio deps can downgrade numpy/protobuf; Basic Pitch needs Python 3.11 + numpy<2 → separate Modal images per stage.
- Melody from transcription: snapping to the **nearest** eighth on the **detected** beat grid fixed alignment; floor-to-slot quantization and a fixed-tempo grid broke it.
- Delete model caches between models when disk is tight; load one heavy model per container.

## 8. Submission checklist
- [ ] Repo **public**, full-history secret scan clean
- [ ] README: what it is, Meta models used, what was built during the hackathon, how to run
- [ ] Video ≤ 3:00, link opens without login
- [ ] Live product works on a fresh browser; demo clips load instantly
- [ ] Only owned / CC-licensed audio and video anywhere
- [ ] Modal + Vercel stay up through Nov 9

## 9. Meta API reference (verified Oct 26, 2026)

Sources: dev.meta.ai docs (`/docs`, `/docs/api-reference/responses/schemas`, `/docs/video-understanding`, `/docs/pricing-rate-limits`, `/docs/sam/segmenting`, `/docs/sam/reading-segmentation`, `/docs/api-reference/voice/realtime`, `/docs/muse-spark-open`, `/docs/muse-glimmer`) and `github.com/facebookresearch/sam-audio`. Items marked **unverified** must be tested before code depends on them.

### Common
- Base URL `https://api.meta.ai/v1`, header `Authorization: Bearer $META_API_KEY`. Responses API (`POST /v1/responses`) plus OpenAI-compatible Chat Completions and Anthropic-compatible Messages; Files API `POST /v1/files` (video: `purpose: "user_data"`).
- Rate limits are per team: Muse Spark standard 3,000 RPM / 4M TPM, contributor 150 RPM / 3M TPM, `sam-3.1` 3,000 RPM.

### Muse Spark (hosted)
- IDs: `muse-spark-1.3`, `muse-spark-1.2`, `muse-spark-1.1`; contributor mode `muse-spark-1.3-contributor`, `muse-spark-1.2-contributor` (cheaper, requests may be used to improve Meta products).
- Audio input: content part `{"type": "input_audio", "input_audio": {"data": "<base64>", "format": "wav" | "mp3"}}`, or `audio_url` / `file_id`. Video parts carry their embedded audio.
- **Mixray uses contributor mode** (`muse-spark-1.2-contributor`); the Add screen tells users their clip is sent to Meta and may be used to improve its models.
- **Use 1.2, not 1.3, for audio:** the docs say audio understanding in 1.3 "is currently not fully supported" and quality may be degraded.
- Reasoning shares the output budget: set `max_output_tokens` ≥ 4000; stream long requests.
- Structured output: `text.format = {"type": "json_schema", "name": …, "schema": …, "strict": true}`.
- Tools: `{"type": "function", "name": …, "description": …, "parameters": {…}, "strict": true}`.
- **Tested Oct 27 on a real 30 s EDM clip — Muse Spark does hear music, but not through `input_audio`:**
  - **`input_audio` is silently dropped.** Every shape returns HTTP 200 with `input_tokens` unchanged from the text-only count, and the model answers that it has no audio: inline base64 (wav and mp3), `audio_url` data URI, `input_file` with `file_data`, and a `file_id` from `POST /v1/files` (upload itself works), on both `/responses` and `/chat/completions`, on `muse-spark-1.1` and `-1.2`. Treat `input_audio` as unavailable.
  - **Workaround: send the audio inside an mp4 as `input_video`** (the docs state a video part carries its embedded audio). Confirmed: `input_tokens` rises to ≈ 2,600 for 30 s and the model names the parts correctly ("arpeggiated lead synth", "pulsing synth bass", "four-on-the-floor kick", "shimmering chord pad", genre "uplifting trance / EDM").
  - **The video track must not be blank.** With black frames only 2 of 5 runs heard the audio; the rest refused with "I only see a black screen" / "as a text-based AI". With the waveform drawn into the frames (`ffmpeg -filter_complex "[0:a]showwaves=s=320x180:mode=line:rate=5"`) 5 of 5 runs heard it. Five runs is a small sample: the engine still retries and validates before trusting a reply.
  - **Never mention the picture in the prompt.** "Ignore the blank picture" reliably triggers the same refusal. Say "this is a music clip" and nothing about frames.
  - **A clip with a picture is sent as itself (Nov 2).** Asking about the audio of a real video
    failed like the waveform: the model described the picture and refused to hear. Asking for every
    source it hears or sees making sound named the real ones in five of six runs on three clips. The
    waveform path stays for audio-only clips, where it failed on three of four uploads; a failed run
    now leaves the clip with no chips instead of a fixed list shown as Muse's.
  - **Give both streams the same length.** `-shortest` against an `lavfi` colour source left a 41 s video over 30 s of audio; pass an explicit `-t`.
  - **Structured output is unreliable while audio is attached:** `json_schema` (strict) worked on a 10 s clip and failed on 30 s, returning an empty object with the same token count. So `suggest` runs in two calls: listen in plain text with the mp4, then structure that text in a second, audio-free call where `json_schema` is safe.
  - **Cost and latency:** ≈ 2,600 input tokens per 30 s clip, 5–8 s per call.
- **Unverified:** audio size and duration limits, and how audio inside video is billed.

### SAM 3.1 (hosted, `sam-3.1`)
- Responses API with `input_text` (prompt) + `input_image` or `input_video` (`video_url` or `file_id`; MP4/MOV, H.264/H.265/MPEG-4, ≤ 15,000 frames, min 50 frames billed). Up to 16 objects.
- Text prompt: a short noun phrase for one thing. Point prompt (pixels, `w`/`h` = media size, `-` prefix = negative): `"<30f>1<|point;x=585;y=366;w=960;h=540|>"` = object 1, positive point on frame 30. `metadata.propagation_direction: "forward"`.
- Output: streamed `output_text`, one line per frame: `<Nf>id<|box;x1=…;y1=…;x2=…;y2=…;w=…;h=…|><|mask;x=0;y=0;data=<H>,<W>,<enc><base85 payload>|>`. Frame indices may skip; ids are sparse integers. Mask encoding is base85 (`~` lossless default, `!` one-bit via `metadata.mask_encoding`); decoding details to confirm in T5.1.

### Muse Voice Transcribe (`muse-voice-transcribe-1.0`)
- Realtime: `wss://api.meta.ai/v1/asr/realtime`. The API key travels in the first JSON frame (`{"authorization": {"accessToken": "Bearer <key>"}, "audioEncoding": "PCM_24KHZ", "model": "muse-voice-transcribe-1.0", "mode": "PUSH_TO_TALK"}`, within 10 s), so **the browser cannot connect directly → Modal WS proxy** as planned.
- Audio: binary frames of 16-bit LE mono PCM at 24 kHz, ~80 ms (3,840 bytes) each. End with `{"type": "endStream"}` and keep the socket open to flush. Server: `{"type": "transcript", "transcript": "…", "final": bool}`, `{"type": "error", …}`.
- File transcription: `POST /v1/asr/transcribe`, multipart with a `request` part (JSON) and an `audio` part — the JSON must carry `audioEncoding` (error: "You must specify the 'audioEncoding' field"). Exact value not yet settled (M4).

### Open-weight models
- **Muse Voice Transcribe has a file endpoint, verified Oct 30.** The realtime socket
  (`wss://api.meta.ai/v1/asr/realtime`, credential in the handshake rather than a header, raw
  `PCM_24KHZ` frames paced at real time, 1008 on a backlog) is not the only way in:
  `POST https://api.meta.ai/v1/asr/transcribe` takes one multipart upload with the usual
  `Authorization` header and answers one JSON body with the transcript and a `turns` array. Fields:
  `model` `muse-voice-transcribe-1.0`, `mode` one of `PUSH_TO_TALK` (the default), `ENDPOINTING` or
  `DIARIZATION`, and `audioEncoding` `WAV`, where the WAV must be mono integer PCM at 16 or 24 kHz.
  Turn-level timestamps only - no word timestamps, no confidence scores, and the limit is
  concurrent streams rather than requests per minute.
  **The multipart body needs exactly two parts, measured on the first live call:** a JSON `request`
  part carrying `model`, `mode` and `audioEncoding`, and the `audio` file part. Flat form fields are
  rejected with `400 invalid_request_error: "Both a 'request' and an 'audio' part are required"`.
  **It writes numbers as words.** A synthesised "loop bars five to eight" came back as exactly that,
  and the command parser, which matched digits, returned nothing - the phrase was heard perfectly
  and the command vanished, with nothing on screen to say why. `parseVoiceCoachCommand` now rewrites
  spoken numbers to digits first.
  **It takes `languageBias` and `keywords`, measured Nov 2.** `languageBias` is a list of full
  language names (`["English"]`) and `keywords` a list of words to favour; both go in the JSON
  `request` part. Without them the model guesses the language and wrote accented English as German
  ("Was ist The Tempo") or with Korean in it. On 60 synthesised commands in six accents, exact
  transcripts went from 22 (neither) to 47 through `/api/voice` (English bias, the command words as
  keywords, 0.4 s of silence around the voice). **A one-word command with no silence before it came
  back empty** ("play", "pause"); the browser now pads the recording. One run per setting, and the
  same audio can transcribe differently from run to run.
  This removes the reason `voice` was cut: push-to-talk is one recording and one POST, so it needs
  no WebSocket proxy on Modal, and the browser already has a 16-bit PCM WAV encoder in
  `apps/web/lib/audio/wav.ts`.
  **It also fixes a compliance problem.** `CoachPanel` reached for the browser's own
  `SpeechRecognition`, which in Chrome sends the audio to Google for recognition - a non-Meta model
  called at runtime, against both `AGENTS.md` and the organizers' ruling that every model called at
  runtime for AI must be a Meta model.

- **Muse Spark Open:** 816B-parameter MoE (42B active); NVFP4 needs a 4-GPU Blackwell node. **Self-hosting on Modal is not feasible for us.** Input text/image/audio/video. Partner IDs: **Baseten `meta-models/muse-spark-open-1026`** (the hackathon-reserved id we use for `recipe`; the public docs' generic id is `meta-models/muse-spark-open`), Together `meta-models/muse-spark-open`, Fireworks `accounts/fireworks/models/muse-spark-open`.
- **Muse Glimmer:** 30B dense, Apache 2.0, **text + image input only**, 128K context. HF `meta-models/Muse-Glimmer-30B`; the ~4-bit GGUF (Q4_K_M ≈ 16.8 GB, ~19 GiB with KV cache) fits one 24 GB GPU (L4) via llama.cpp.
- **Baseten request shape for `recipe`, verified in the docs Oct 30 (not guessed).**
  `POST https://inference.baseten.co/v1/chat/completions`, headers `Authorization: Bearer
  <BASETEN_API_KEY>` and `Content-Type: application/json`, body `{"model": "...", "messages":
  [{"role": "user", "content": "..."}]}` - the OpenAI chat-completions format, with the model slug
  in `model`. Three Muse Spark Open limits matter here:
  - **It accepts `json_schema` but does not enforce it.** Every other model on their Model APIs
    supports structured output and JSON mode; Muse Spark Open is the documented exception. So the
    recipe asks for JSON in the prompt and the reply is parsed defensively and retried, exactly as
    `suggest` has to do - never trusted because the request named a schema.
  - `n > 1` returns HTTP 400, so no sampling several candidates in one call.
  - `logprobs` and `top_logprobs` are accepted and silently ignored.
  It accepts text, image, audio and video input. `recipe` still sends spectral statistics as text
  rather than the audio itself: the statistics are deterministic and cheap, the audio content-part
  format on this serving stack is unverified, and the requirement is that Muse Spark Open be
  used, not that it be fed audio. Sending the clip is the upgrade if time allows.
  The key lives in its own Modal Secret, `mixray-baseten`, following `mixray-hf`: adding a key to
  `mixray-secrets` means `modal secret create --force`, which replaces the whole secret and would
  drop the engine's auth and Meta keys if one were left out of the command.

- Implication for `recipe`: either Muse Spark Open via partner inference (partner inference, no Modal GPU cost, can hear the sound) or Muse Glimmer self-hosted on L4 (text stats + spectrogram image). **Decided: Muse Spark Open via Baseten.**

### SAM Audio (open weights, self-hosted)
- Install from the cloned repo (`pip install .`), Python ≥ 3.11, CUDA GPU; gated HF checkpoints `facebook/sam-audio-{small,base,large}` and `-tv` variants (better target correctness and visual prompting); `facebook/sam-audio-judge` for reranking.
- Sizes (paper): 500M / 1B / 3B parameters excluding the PE visual encoder, T5 text encoder and DAC-VAE codec.
- Usage: `SAMAudio.from_pretrained(id)`, `SAMAudioProcessor.from_pretrained(id)`, `processor(audios=[path], descriptions=["supersaw synth lead"])`, `model.separate(batch, predict_spans=False, reranking_candidates=1)` → `result.target` (sound), `result.residual` (rest), rate `processor.audio_sampling_rate`. Visual: `masked_videos=processor.mask_videos([frames], [mask])`. Spans: `anchors=[[["+", start, end]]]`.
- **Measured Oct 27 on Modal 24 GB GPU (23.7 GB, torch 2.14.1+cu130, `fp32`, `predict_spans=False`, `reranking_candidates=1`): `facebook/sam-audio-small` separates a 30 s clip in 5.1 s with 14.26 GB peak VRAM.**
  - **Key fix — disable rankers and span predictor at load time, and NEVER pass `strict=False`:** pass `visual_ranker=None, text_ranker=None, span_predictor=None` (with the default `strict=True`) to `SAMAudio.from_pretrained(model_id, ...)`. Without those three `None` kwargs, `SAMAudio.__init__` unconditionally calls `create_ranker(cfg.visual_ranker)`, which both blows up VRAM (ImageBind 4.47 GB + CLAP 1.86 GB) and raises `AssertionError: Install ImageBind` because `imagebind`'s `setup.py` sets `install_requires=[]` and `imagebind/data.py` fails on `from pytorchvideo import transforms`. **Critical bug in upstream `sam_audio/model/model.py` (`SAMAudio.load_state_dict`, line 359):** the method is written as `if strict: ...` with **no `else:` branch**! Passing `strict=False` makes `load_state_dict` a complete no-op (`super().load_state_dict` is never called), leaving `audio_codec`, `transformer`, and `vision_encoder` randomly initialized (~16× quieter noise that does not sum back to the mix). With the default `strict=True`, `SAMAudio.load_state_dict` internally calls `super().load_state_dict(state_dict, strict=False)` and filters `^text_encoder|^visual_ranker|^text_ranker|^span_predictor` out of `missing_keys`, so disabling the rankers works cleanly with `strict=True`.
  - **Rankers and `xformers` do not participate in single-candidate separation:** `SAMAudio._get_forward_args` and `SAMAudio.separate` never touch `visual_ranker` or `text_ranker` when `reranking_candidates == 1` (`sam_audio/model/model.py` lines 208–345), and `DiT` (`sam_audio/model/transformer.py` line 158) uses `torch.nn.functional.scaled_dot_product_attention`, never `xformers`.
  - **Submodule breakdown (`fp32`, 5.539 GB total, 5.558 GB on GPU after `.cuda()`):** `vision_encoder` 2.685 GB, `transformer` 1.968 GB, `text_encoder` 0.439 GB, `audio_codec` 0.431 GB, projections (`proj`, `align_masked_video`, `memory_proj`, `embed_anchors`) 0.017 GB. Warm load from Modal Volume takes 11.5 s.
  - **Why `.half()` failed:** `processor(...)` emits `float32` audio tensors while DAC-VAE `weight_norm` layers have `Half` biases (`RuntimeError: Input type (float) and bias type (c10::Half) should be the same`). Since `fp32` peaks at 14.26 GB on a 23.7 GB card, run full `fp32`.
  - **Output shape & WAV saving:** `separation.target` and `separation.residual` are `list[Tensor]` (1D tensor per batch item), and TorchAudio ≥ 2.9 routes `torchaudio.save` through `torchcodec` (not installed in the image). Index `[0]`, `.unsqueeze(0)` for channels, and write 16-bit PCM WAV via Python's stdlib `wave` module.
  - **Separation verified Oct 27, and a wrong prompt fails quietly.** Asking for "synth lead" on a
    test clip that has none returned noise at a plausible level: `target` and `residual` both
    sat at rms 0.010 against the mix's 0.161 and reconstructed nothing (error 1.007). With prompts
    that match what is playing, the same clip and model behave correctly:

    | prompt | target rms | residual rms | residual / mix | recon error | target zero-crossings |
    |---|---|---|---|---|---|
    | synth chord | 0.126 | 0.079 | 0.49 | 0.149 | 0.0199 |
    | hi-hat | 0.095 | 0.108 | 0.67 | 0.164 | 0.0151 |
    | room ambience | 0.101 | 0.108 | 0.67 | 0.150 | 0.0248 |
    | kick drum | 0.072 | 0.124 | 0.77 | 0.158 | 0.0028 |
    | bass | 0.073 | 0.124 | 0.77 | 0.155 | 0.0031 |

    The mix itself crosses zero at 0.0215. Kick and bass isolate content seven times lower in
    frequency, and their residuals match the mix's rate (0.0217, 0.0218) — the music survives
    losing them. Removing the chords instead brightens the residual to 0.0370. Energy moves the way
    it should too: chords dominate this track and take half the mix, a kick takes a fifth.
    Reconstruction error settles near 0.15 rather than 0 because SAM Audio resynthesises instead of
    masking; that is fine for Mixray, which plays the two sides separately rather than summing them.
  - **Do not pass `strict=False`.** It was added to silence the unused ranker weights, and it is
    what produced the broken run above — even though `load_state_dict` reported no missing or
    unexpected keys. The load that works is `SAMAudio.from_pretrained(model_id, visual_ranker=None,
    text_ranker=None, span_predictor=None)` with no `strict` argument. Without the ranker kwargs
    entirely, construction fails on `AssertionError: Install ImageBind`, because `imagebind` is
    pip-installed but not importable in this image; `reranking_candidates=1` never needs it.
  - **A prompt for something absent returns noise, not silence or an error**, so `suggest` must only
    offer prompts for sounds Muse actually heard, and the UI should not promise an arbitrary prompt
    will work. The tell is spectral: the isolated output crossed zero three times as often as the
    mix.
  - **Implication for Modal:** a single 24 GB GPU (`L4` or `A10G`) is sufficient and fast (5.1 s per 30 s clip) in `fp32` with `vision_encoder` still resident for video prompts.
  - **Signal energy & reconstruction (`"synth lead"` on the 30 s test clip):** `mix_rms = 0.16069`, `sound_rms = 0.07149`, `rest_rms = 0.12179`, `reconstruction_error = 0.17204` (`rms(mix - (sound + rest)) / rms(mix)`, matching DAC-VAE codec roundtrip). The isolated lead carries a clean subset of the mix energy while the backing track stays in `rest`.
  - **Quality levers, read from the pinned source Oct 28 (not yet measured on GPU).** The first
    isolations sounded weak, and the cause is configuration, not the weights: `run_isolation` asks
    for `reranking_candidates=1`, and at that setting `separate` generates exactly one sample from
    noise and returns it unjudged.
    - **Official subjective scores (`README.md`) rule out the obvious upgrade.** `sam-audio-base`
      scores **below** `-small` on music (3.87 vs 4.11); only `-large` improves on it (4.22 music,
      4.49 instruments-pro vs small's 4.24). So model size is a weak lever for Mixray and
      `-base` should never be tried. The `-tv` variants are documented as better specifically on
      *correctness of the target sound*, which is Mixray's actual promise.
    - **Candidate reranking is the strong lever.** The README calls `predict_spans=True` with
      `reranking_candidates=8` "better results at the cost of latency and memory".
    - **Only CLAP is needed for text prompts.** `SAMAudio.separate` (`sam_audio/model/model.py`
      lines 319–334) scores candidates with `visual_ranker` **only when `batch.masked_video is not
      None`**, and otherwise with `text_ranker`. So the text path never touches ImageBind, and the
      `AssertionError: Install ImageBind` above only ever came from letting the *visual* ranker
      default in. Keep `visual_ranker=None`; the ImageBind import never has to be fixed for audio.
    - **Reranking is silently dead until `text_ranker` is passed in.** `SAMAudioConfig.__init__`
      (`sam_audio/model/config.py` lines 214–216) defaults `visual_ranker=None` and
      `text_ranker=None`, and with both None the final `else` branch sets `idxs = zeros`, i.e. it
      keeps candidate 0 and throws the other k−1 away. Raising `reranking_candidates` alone costs
      k× the compute and changes nothing. Pass `text_ranker={"kind": "clap"}`; `parse_ranker_config`
      **pops** `"kind"` out of the mapping, so build a fresh dict per load.
    - **Ranker kinds available** (`sam_audio/model/config.py` lines 138–200): `imagebind`, `clap`,
      `judge` (`facebook/sam-audio-judge`), `sound_activity`, and `ensemble`, which takes
      `{name: (config, weight)}` and is the highest-quality option. `judge` scores precision,
      recall and faithfulness, so it also gives an **objective** quality number instead of relying
      on listening.
    - **VRAM risk:** each candidate integrates the ODE on its own copy of the clip, so activations
      scale with k. At k=1 the peak is 14.26 GB of a 23.7 GB card, which leaves room for roughly
      k=2 and makes k=8 unlikely to fit on 24 GB. `engine/isolate.py::quality` therefore climbs
      `(spans, k)` rung by rung and records each rung before the next can fail.
    - **Prompt format matters:** the README asks for lowercase noun-phrase / verb-phrase text to
      match training ("thunder", not "thunder can be heard in the background"). `suggest` chips and
      the prompt input must follow that.
  - **Measured Oct 28 on Modal A10 (23.7 GB), `sam-audio-small`, `fp32`, prompt `"synth chord"`,
    CLAP text ranker and the default span predictor both loaded.** Loading the rankers moves peak
    VRAM from 14.26 GB to **21.03 GB**, which leaves under 1 GB of headroom, and candidate
    reranking is therefore impossible on a 24 GB card:

    | spans | k | seconds | peak VRAM | target rms | rest rms | recon | result |
    |---|---|---|---|---|---|---|---|
    | off | 1 | 5.4 | 21.03 GB | 0.12143 | 0.07816 | 0.157 | ok |
    | on | 1 | 9.1 | 21.03 GB | 0.12507 | 0.07938 | 0.151 | ok |
    | on | 2 | — | — | — | — | — | **OOM**, wanted 2.06 GiB more |
    | on | 4 | — | — | — | — | — | **OOM**, wanted 4.12 GiB more |
    | on | 8 | — | — | — | — | — | **OOM**, wanted 8.24 GiB more |

    - **`predict_spans=True` is a real but small win:** reconstruction error drops from 0.157 to
      0.151 and the isolated target carries slightly more energy, for 3.7 s more compute.
    - **Why reranking cannot fit:** `SAMAudio.separate` expands the batch to `k` copies of the clip
      and integrates the ODE over all of them at once, so activations scale linearly with `k` while
      the ranker weights have already taken the headroom. The OOM sizes scale exactly 2.06 / 4.12 /
      8.24 GiB for k = 2 / 4 / 8, confirming it is the candidate batch and not the rankers.
    - **The fix that keeps the cheap GPU:** generate candidates **sequentially** with `k=1` and
      score them with CLAP in our own code. VRAM then stays flat at 21.03 GB regardless of how many
      candidates are drawn, and only time grows (about 9 s per candidate). This works precisely
      because SAM Audio is generative and non-deterministic: it integrates the ODE from fresh noise
      each call, so repeated `k=1` calls genuinely produce different candidates to choose between.
      The alternative is an A100 40 GB, which needs no code change but costs about 2.6x per hour.
    - **Unverified:** the 78.5 s load in this run included downloading CLAP and `pe-a-frame-large`
      for the first time. Both now sit in the `mixray-weights` Volume, so the warm load cost of
      enabling them is not yet known and must be measured before `predict_spans=True` goes into the
      production path, where it would be paid on every cold start.
  - **Sequential reranking measured Oct 28 on an A10, `sam-audio-small`, prompt `"synth chord"`,
    4 candidates drawn one at a time with `predict_spans=True, reranking_candidates=1`:**

    | candidate | seconds | peak VRAM | target rms | rest rms | recon | CLAP |
    |---|---|---|---|---|---|---|
    | 1 | 9.7 | 21.03 GB | 0.11433 | 0.09044 | 0.149 | 0.06618 |
    | 2 | 4.8 | 21.03 GB | 0.08563 | 0.12158 | 0.147 | **0.00426** |
    | 3 | 4.8 | 21.03 GB | 0.10837 | 0.10437 | 0.145 | 0.03627 |
    | 4 | 4.8 | 21.03 GB | 0.12431 | 0.08108 | 0.151 | **0.07252** |

    - **Peak VRAM is flat at 21.03 GB across all four candidates**, confirming that drawing
      sequentially sidesteps the out-of-memory wall entirely. Only time grows, and less than
      expected: the first draw costs 9.7 s because it warms the span predictor, every later draw
      4.8 s. Four candidates therefore cost about 24 s instead of 5 s.
    - **This is the real cause of inconsistent isolation quality.** The spread between the best and
      worst candidate is 0.06827, which is almost as large as the best score itself: a 17x
      difference from the same model, prompt and clip, differing only in the noise the ODE started
      from. Production currently draws exactly once, so it lands on a candidate of random quality —
      sometimes candidate 4, sometimes candidate 2.
    - **CLAP is scoring the right thing.** Its ranking is perfectly monotonic in how much target
      energy each candidate captured (0.12431 > 0.11433 > 0.10837 > 0.08563 maps exactly onto
      0.07252 > 0.06618 > 0.03627 > 0.00426). By those numbers the worst candidate left most of the
      chord energy behind in the residual; the listening check is still ours to make.
      Reconstruction error does **not** separate them (0.145–0.151),
      so it is useless as a quality signal and CLAP is doing work no cheap metric replaces.
    - **Warm load is 65.6 s** with the ranker and span predictor cached in the Volume, against
      78.5 s cold, so caching saves only 13 s and the cost is building and moving the models rather
      than downloading them. This is paid on every cold start and is the main open cost question for
      putting reranking into the production path.

### Basic Pitch (transcription)
- On Linux with Python 3.11, `basic-pitch==0.4.0` requires TensorFlow as a **base** dependency, not
  an optional backend: `tensorflow<2.15.1,>=2.4.1; platform_system != "Darwin" and python_version >=
  "3.11"`. The `onnx` extra exists but does not displace it, so 2.15.0 is the only choice and
  `numpy<2` follows from TensorFlow. There is no lighter backend available at this Python version.
- **If the transcription image's size or import time ever matters**, note that basic-pitch pulls the
  much smaller `tflite-runtime` instead of full TensorFlow on `python_version < "3.11"`. Since each
  heavy model already gets its own image, that image alone could drop to Python 3.10 to take the
  lighter runtime. Not done: the engine is otherwise pinned to 3.11 and transcription is not on the
  hot path.

### Demucs (fallback separator)
- **Verified Oct 28 by running it locally on CPU** (`demucs==4.1.0`, `htdemucs_6s`, a 30 s clip):
  - **Demucs needs numpy but does not declare it.** `demucs/transformer.py` imports numpy
    unconditionally, while the package requires it only on macOS x86_64, so `pip install demucs`
    succeeds on Linux and then fails with `ModuleNotFoundError: No module named 'numpy'` on
    `import demucs`. The image must pin numpy explicitly. 4.1.0 runs correctly on numpy 2.4.6.
  - Output layout is `<--out>/htdemucs_6s/<stem>.wav`, and `--filename "{stem}.{ext}"` does remove
    the per-track subdirectory, which is what `engine/fallback.py` assumes.
  - The six stem names are exactly `bass, drums, guitar, other, piano, vocals`, matching the
    schema's `StemName` enum with nothing left over.
  - Stems are written as **16-bit PCM**, so reading them with `wave` and `audioop.rms` is valid.
    Had Demucs written float32, that RMS would have silently produced nonsense levels.
  - 12.5 s for a 30 s clip on an M-series CPU, so the 900 s Modal timeout is generous.
  - End to end on a cached clip, `run_fallback` wrote six schema-valid `fallback_stems` entries with
    MP3s, levels normalised to a loudest of exactly 1.0, and left `isolations` and `tempo` untouched.
- **Lesson worth keeping:** package metadata is not evidence that code runs. Two failures today had
  the same shape — an install or a deploy that reported success, then died on import at first real
  use: the missing numpy above, and three Modal images that did not ship every module `app.py`
  imports. Neither was visible without executing the thing.

- **Basic Pitch verified Oct 28 by running it locally** on a Demucs-isolated piano stem, which is
  what transcription actually sees in production:
  - **`resampy` imports `pkg_resources` without declaring setuptools**, so `import basic_pitch`
    fails on a clean environment. setuptools dropped `pkg_resources` after 80.9.0 and its own
    warning says to "pin to Setuptools<81", so the image pins 80.9.0. basic-pitch caps
    `resampy<0.4.3`, and those releases are the ones that still reach for it.
  - `predict` returns note events as 5-tuples of `(start, end, pitch, amplitude, bends)`, with
    numpy scalars that must be converted before the trackmap is serialised, and **the events are not
    in time order** - the first event of this run started at 29.24 s. Code that assumes sorted input
    is wrong; `engine/transcribe.py` sorts.
  - 5.3 s for a 30 s clip on CPU, 84 events, pitches 36-81, amplitudes 0.26-0.73.
  - **The easy register cannot be reached by one shift on real material.** The transcription spanned
    45 semitones while the easy window (60-84) is 24, so a single whole-octave shift left 7 of 45
    notes outside it and the keyboard, which draws C4-B5, had nothing to show them on. Notes the
    shift cannot reach are now folded individually; after the fix all 45 landed in 60-82.
  - Eighth-note snapping was verified against the grid the code actually builds, which is **not
    uniform**: the analysed beats on this clip ranged from 0.441 s to 0.558 s apart. A first check
    against an evenly spaced grid wrongly reported 43 of 45 notes off-grid; against the real grid
    all 45 are on it. Any test of snapping has to use `_eighth_grid`, not an assumed tempo.
  - **Backend caveat:** on macOS basic-pitch runs through coremltools, while the Modal image uses
    TensorFlow. This run therefore verifies the event parsing, the confidence aggregation and the
    arrangement logic, not the Linux/TensorFlow path.

### Trackmap writes (architecture, settled Oct 28 after a production failure)
- **Producers never mutate `trackmap.json`.** Each writes its own sidecar next to the clip and the
  served trackmap is assembled from them on read:
  `analysis.json`, `fallback_stems.json`, `isolations/<iso>/isolation.json` and
  `isolations/<iso>/transcription.json`. A missing sidecar contributes nothing.
- **Why, measured:** `transcribe_worker` and `fallback_worker` run concurrently in separate
  containers, and both used to reload the Volume, read the whole trackmap, set one field and write
  the whole file back; `IsolationWorker` committed the same file too. A real run showed both workers
  logging success ("212 notes, confidence=0.505" and "cached 6 Demucs fallback stems") with all
  their audio on the Volume, while the served trackmap had `notes: 0` and no `fallback_stems` key.
  The only two writes that survived were the two with no concurrent writer. Sidecars remove the
  shared mutation instead of narrowing the window, so the outcome no longer depends on interleaving.
- Verified by running all four producers against one clip: the assembled trackmap carried the real
  tempo, the isolation, its notes and six fallback stems together, validated against schema v2, and
  the `trackmap.json` on disk still held its ingest-time placeholders.

- **Visual prompting measured Oct 29 on an A10**, four performers in one orchestra clip (violinist,
  cellist, pianist, singer), each masked by a hand-checked box, against the equivalent text prompt:

    | target | mask: s / peak / rms | text: s / peak / rms |
    |---|---|---|
    | violin | 40.7 / 15.46 GB / 0.07204 | 4.4 / 14.27 GB / 0.06634 |
    | cello | 37.9 / 15.74 GB / 0.06456 | 4.5 / 14.27 GB / 0.05577 |
    | piano | 38.2 / 15.74 GB / 0.06777 | 4.5 / 14.27 GB / 0.05614 |
    | voice | 38.5 / 15.74 GB / 0.06294 | 4.5 / 14.27 GB / 0.06750 |

  - **It works mechanically.** `descriptions=[""]` with `masked_videos` is accepted and all eight
    trials completed; a 300-frame 448x252 uint8 NCHW tensor costs only about 1.5 GB more than the
    text path, so a 24 GB card is still enough.
  - **It costs 8-9x the time:** about 40 s per mask against 4.5 s per text prompt, because the
    vision encoder runs over frames resampled to the audio feature length. That is the number to
    design the click flow around.
  - **Masks do NOT prove the right source was picked.** All eight outputs sit between 0.056 and
    0.072 rms with reconstruction error near 0.33, well above the 0.15 seen on the test clip,
    and nothing in those numbers says the pianist's box returned piano. Deciding whether visual
    prompting is worth its latency needs either listening or a CLAP cross-score of each output
    against each label; the rms figures alone cannot answer it.
  - **`mask_videos` inverts the mask:** it computes `video * mask.eq(0)`, keeping the pixels where
    the mask is **zero**. A segmenter's mask marks the object with ones, so passing it unchanged
    isolates the background. `engine/isolate.py::_box_masked_frames` inverts it, and T5.1 has to do
    the same with the SAM 3.1 mask.

- **`input_video` shape, corrected Oct 29 against a 400 from the API.** The media source sits
  **directly on the content part**, not nested under an `input_video` object, and inline bytes
  travel as a base64 **data URL**, not a `data` field:
  `{"type": "input_video", "video_url": "data:video/mp4;base64,<...>"}` or
  `{"type": "input_video", "file_id": "file-..."}`. A part carrying `{"data": ..., "format": ...}`
  is rejected with *"input_video content part requires `video_url` or `file_id`"*. The audio shape
  above does not generalise to video, and assuming it did cost a run.
- **`suggest` works, and the mp4 workaround is not reliable every time.** First end-to-end run on a
  30 s orchestra clip returned a musically sensible description and three chips. A second run, with
  only the listening instruction reworded, came back describing the picture instead: *"Only a red
  waveform amplitude over time on a black background was shown with no audible audio"*, and it
  produced the chips "No Audible Audio" and "Waveform Image Only". The reply was perfectly
  well-formed, so shape validation let it straight through to the trackmap.
  - **Validating the shape is not enough; the reply has to be checked for deafness and retried.**
    `engine/suggest.py::heard_audio` looks for the words those failures use and `listen_to_clip`
    asks again, up to three times, before giving up. Verified against six real replies, three good
    and three refusals, including both refusals recorded during T0.5.
  - **Chip accuracy is partial.** On a clip with a violinist, a cellist, a pianist and a singer, the
    good run named the piano and the voice, missed both string players, and offered "room reverb",
    which is a property rather than a source. Demucs put 1495 rms into its guitar stem on the same
    clip, which for an orchestra is the strings, so they were audible and were missed. The chips are
    therefore a starting point, not a complete index: the prompt box has to stay prominent.

### SAM 3.1 masks, confirmed Oct 29 (this closes the "decoding details to confirm in T5.1" note)
- **Do not decode the payload by hand.** It is base85 in a variant the docs do not name, and Meta
  ships the decoder: `meta-sam-parser` on PyPI, pure Python with no runtime dependencies. It
  provides `build_object_prompt` for the point/box prompt wire format and `decode_mask_to_raster`,
  `decode_mask_to_rle` and `decode_mask_to_svg_path` for the payload.
- **Masks are box-local, and the polygons are useless without placing them.** `SegmentationMask`
  carries the raster's own `width`/`height`, "not the frame's", while `SegmentationMaskRecord.bounds`
  gives the half-open source-media box that raster covers. A decoded path therefore starts at the
  origin of its own little raster: on a 640x360 frame the pianist's path came back spanning x 0..96,
  y 0..156. Drawing that unchanged would pile every outline into the top-left corner at the wrong
  size. `engine/track.py::to_frame_space` maps each point with
  `left + x * (right - left) / mask.width` and the matching formula for y.
- **`object_id` arrives as text, not a number.** Comparing it to an int matches nothing and the
  filter silently yields an empty result; mypy caught this one.
- **Send the video at the mask frame rate.** Frame indices in the reply index whatever video was
  posted, so posting the source-rate copy while converting indices to seconds at 10 fps stretches
  every visible range by the ratio between them. Billing is per frame too, so a 10 fps re-encode is
  both the correct and the cheaper thing to send.
- **Measured end to end on a 30 s 640x360 orchestra clip**, one positive point on the pianist at
  (307, 207) of frame 0: 300 mask frames, exactly 30 s x 10 fps, and one visible span [0.0, 29.9].
  The mask box was x 276..374, y 132..288 against a performer occupying roughly x 265..345,
  y 135..280, and the centroid moved from (324, 213) to (327, 213) across the whole clip, so
  tracking held without a second prompt. Confirmed by rendering the box over the frame, not only by
  reading the numbers.

- **Pointing versus typing, measured Oct 29 end to end on the same 30 s clip and the same source**
  (a tap on a performer, tracked by SAM 3.1, against the text prompt for the instrument he plays):

    | path | seconds | peak VRAM |
    |---|---|---|
    | tap -> mask -> SAM Audio | 59.1 | 15.73 GB |
    | text prompt | 5.2 | 14.26 GB |

  - **Pointing costs about eleven times the latency**, worse than the nine measured earlier with
    crude rectangles, because a real track decodes 300 per-frame rasters. The run also logged one
    allocator retry after a failed 3.87 GB allocation, so a 24 GB card has little headroom left on
    this path.
  - Whether the extra wait buys a better separation is a listening question; the numbers do not
    settle it, and it decides whether the click flow is worth building as a 60 s operation or
    whether the tap should instead name the instrument and hand it to the fast text path.

  - **Listening verdict (builder, Oct 29):** the mask path makes the target louder but lets small
    amounts of other sounds in; the text path is quieter and more purely the target. **Cleanliness
    is the dimension that matters**, because level is one gain away while leakage is not, and the
    isolated sound feeds Basic Pitch, which tolerates a quiet source but turns leakage into
    spurious notes. So the text path wins on quality as well as on being eleven times faster.
  - **Consequence for the product:** keep the tap as the interaction, but do not separate from the
    mask. The tap goes to SAM 3.1 for the mask that shows what was selected, the masked region is
    named, and that name drives the fast text separation - roughly seven seconds instead of sixty,
    with the cleaner result. SAM 3.1 keeps its job: it is what makes pointing possible, and the
    overlay is what makes the choice visible.

- **Naming a selected region works (measured Oct 30, `engine/label.py`).** One Muse Spark call on a
  cropped frame identifies the instrument, and the crop can be loose: three boxes around the same
  player - 130x140, 230x220 and 400x320 px - all came back with the same sound, so the crop does not
  have to hug the mask. The image part is
  `{"type": "input_image", "image_url": "data:image/png;base64,<...>"}`, confirmed in the image
  understanding docs rather than guessed. **Latency varies a lot: 5-20 s across six live calls**, so
  the tap flow costs roughly 10-25 s end to end, not the seven estimated above - still far below the
  sixty of mask separation, but the UI has to show progress rather than promise a snap.
  Two traps, both measured:
  - **The reply's wording needs normalising, not validating.** With audio attached, structured
    output is unreliable; with only an image it returns valid JSON, but the strict schema checks
    shape and not wording, so `prompt` came back as a full sentence with markdown bold and a brand
    name ("The image shows an **ARTURIA MiniLab 3 - 25-key USB MIDI Controller Keyboard**"). A
    separator needs the generic noun phrase, so the parser strips emphasis and anything after the
    first `(` or ` - `, keeps the last three words - the head noun sits at the end of
    "piano-style keyboard" - and only fails when nothing usable is left. Rejecting these replies
    would have thrown away a correct identification.
  - **Reasoning shares the output budget.** A 15.9 s call was cut off mid-JSON after the label, with
    no prompt field, until the cap was raised to the 4000 tokens `suggest` already needed.
  - The display label is derived from the cleaned prompt rather than taken from the reply, so a chip
    and its separation prompt can never name two different sounds. Acronyms are cased in one place,
    because `str.title` writes "midi" back as "Midi".
