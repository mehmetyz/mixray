# Mixray — Design Spec

> UI reference for `apps/web`. Source of truth for colors, type, layout and the five screens.

**Look:** quiet monochrome DAW. Soft near-black neutral ground (`#131417`), thin `1px` hairlines (`#24262D`), soft off-white primary text (`#EAECEF`), cool neutral secondary copy, and a tiny surgical touch of orange (`#FF6A1A`) reserved strictly for precision indicators (wordmark `x`, active step dot, selected SAM 3.1 mask outline, active isolated waveform, sounding reference notes). Primary buttons and selected switches use crisp monochrome contrast (`--text` fill with `--bg` ink). A pale amber (`#F5B971`) marks `--you` (user take dots and the problem bar). No gradients, no glow washes, no emoji.

**Flow:** `1 Add → 2 Pick a sound → 3 X-Ray → 4 Learn → 5 Take home`.

---

## 1. Tokens

### Colors (CSS variables in `app/globals.css`)

```css
:root {
  --bg:            #131417; /* app shell ground */
  --surface:       #16181c; /* sidebar, header, inspector, transport, lane headers */
  --surface-2:     #1e2027; /* elevated controls, active step row, chips */
  --inset:         #0e0f12; /* lane canvas wells, piano roll, video stage, code wells */
  --line:          #24262d; /* 1px panel & lane dividers */
  --line-2:        #2c303a; /* grid lines, control borders */
  --control:       #383c47; /* hover borders, dashed drop/mask borders */
  --inactive:      #454954; /* unplayed waveform bars, idle meters */
  --muted-wave:    #23252c; /* waveform of muted stems */

  --text:          #eaecef; /* primary copy, active monochrome controls */
  --text-2:        #b4bac6; /* secondary copy */
  --text-muted:    #8b919e; /* labels, metadata (≥ 5.1:1 contrast on --bg, --surface, --surface-2) */

  --accent:        #ff6a1a; /* surgical precision accent: logo x, active sound wave, selected mask, sounding note */
  --accent-ink:    #131417; /* text on --accent */
  --accent-hover:  #ff8542;
  --you:           #f5b971; /* user take dots, problem bar highlight */

  --rest:          #b8bdc7; /* Full mix and Rest of mix audible waveforms */
  --left-hand:     #7c8599; /* intermediate left-hand root+fifth blocks */
  --left-hand-2:   #636b7d;
  --key-white:     #e4e6ea; /* on-screen white piano keys */
  --key-white-ink: #131417;
  --key-black:     #1b1d23; /* on-screen black piano keys */
}
```

Expose them to Tailwind (`@theme inline` in Tailwind v4): `bg-bg`, `bg-surface`, `bg-surface-2`, `bg-inset`, `border-line`, `border-line-2`, `border-control`, `text-text`, `text-text-2`, `text-muted`, `bg-accent`, `text-accent`, `text-you`, etc. Do not hard-code hex in components; canvas helpers read CSS custom properties from `:root`.

**Rules:** `--accent` and `--you` differ in lightness, not just hue, so reference vs. take stays readable for color-blind users. Sound vs. rest is always labelled, never distinguished by color alone. Primary interactive buttons use `bg-text text-bg` rather than large orange fills, keeping `--accent` small and surgical.

### Typography

| Role | Font | Size / weight |
|---|---|---|
| Wordmark | Sans | 16 / 700, lowercase (`mi` + `x` in `--accent` + `ray`) |
| Section / screen title | Sans | 18–24 / 600, tracking −0.02em |
| Lane / panel heading | Sans | 12–14 / 600 |
| Body & controls | Sans | 12–14 / 400–500, line-height 1.45 |
| Eyebrow / section tag | JetBrains Mono | 11 / 600, tracking 0.1em, uppercase, `--text-muted` |
| Numbers (BPM, key, bars, timecode, chords, prompts, tool args) | JetBrains Mono | 11–16 / 500–600, `tabular-nums` |

Load clean geometric sans + `JetBrains_Mono` via `next/font/google` (with system UI sans/mono fallbacks).

### Shape and spacing

- Radii: panels & cards `8px` (`rounded-card`), wells `6px` (`rounded-well`), buttons/inputs/chips `4px` (`rounded-icon`).
- Borders: crisp `1px` solid `--line` / `--line-2`.
- Touch & click targets: interactive buttons and step links comfortable on desktop and ≥ 36–44px tap area on mobile.

---

## 2. Studio Shell

Desktop-first DAW frame (`100dvh` on `lg+`, scrollable stacked panels on mobile):

1. **Top Status Bar (`44px`, `--surface`, bottom border `--line`):**
   - Left: `mixray` wordmark linking to `/` (`Add`), current clip title + `BPM · Key` in mono.
   - Center/Right on mobile (`< lg`): horizontal scrollable 5-step bar (`01 Add · 02 Pick · 03 X-Ray · 04 Learn · 05 Export`).
   - Right on desktop: `Meta SAM 3.1 · SAM Audio · Muse Spark` mono label.
2. **Left Sidebar (`224px` on `lg+`, `--surface`, right border `--line`):**
   - **Workflow (`01`–`05`):** vertical step list (`01 Add`, `02 Pick a sound`, `03 X-Ray`, `04 Learn`, `05 Take home`). Active step gets `--surface-2` fill, `1px` `--line-2` border, and a `6px` `--accent` dot on the right. Steps `03–05` stay disabled until at least one isolation exists; links preserve `?iso=<isolationId>`.
   - **Isolated sounds:** list of `trackMap.isolations` for the clip; clicking switches `?iso=...` immediately across all screens.
   - **Shortcuts:** compact mono legend (`Space` Play/Pause, `1/2/3` Sound/Rest/Mix, `A–L` Piano keys).
3. **Center Stage (`flex-1`, `--bg`):**
   - **Shared Bar & Time Ruler** (steps `02–05`): 16-bar grid (`1`..`16`), loop range highlight, `1.5px` playhead, click/drag to seek.
   - **Lanes workspace:** stacked horizontal `1px`-bordered lanes specific to the current step.
4. **Right Contextual Inspector (`320px` on `lg+`, `--surface`, left border `--line`):**
   - Contextual controls and AI outputs for the active step (`Pick`, `X-Ray`, `Learn`, `Take home`, or `Demos` on `Add`).
5. **Bottom Persistent Transport Bar (`56px`, `--surface`, top border `--line`, mounted in `app/c/[id]/layout.tsx` so audio never stops across steps `02–05`):**
   - Left: Return-to-zero (`|<`), Play/Pause button (`Space`), mono `BAR.BEAT | MM:SS.d / MM:SS.d` readout.
   - Center: segmented monitor switch **`Sound | Rest | Full mix`** (`1` / `2` / `3`, active = `bg-text text-bg`).
   - Right: Tempo/Rate slider (`50%–100%` step `5%`, `preservesPitch`) and `Loop` toggle button.

---

## 3. Screens

### 3.1 Add (`/`)

- **Center workspace:**
  - Eyebrow `01 · ADD MEDIA`, title **"Drop a song or video you own. Pick up to 30 seconds."**
  - **Drop zone:** dashed `1px` `--control` border, `--inset` fill, accepts MP3, WAV, FLAC, M4A, MP4, MOV (`≤ 50 MB`, `≤ 6 min`).
  - **ClipPicker** (shown once a file is chosen): file name + duration, 8-frame filmstrip above the waveform for video files, waveform with a scrubbable/draggable `≤ 30 s` window outlined in `--accent`, mono `start → end (duration)` readout, local window preview button.
  - **Rights & contributor-mode gate:** checkbox `"I own this file or have the rights to use it."` plus one-line disclosure `"Clips are sent to Meta SAM and Muse models in contributor mode and may be used by Meta to improve its models."` Primary `Open in Pick →` button stays disabled until checked. Audio trims in-browser via `trimToClip` (`WAV`) before `uploadClip`; video uploads whole (`≤ 50 MB`).
- **Right inspector:** **Precomputed demos** (`Supersaw sketch · 128 BPM · Am` + Quartet visual mask preview) with zero GPU wait, plus pipeline notes.

### 3.2 Pick a sound (`/c/[id]/pick`)

- **Center lanes:**
  - **Video stage** (shown when `trackMap.video` exists, or when previewing the Quartet visual-mask demo): 16:9 `--inset` panel with `<video>` and interactive `<button aria-pressed>` mask regions. Selected mask uses `1px` `--accent` border and crisp monochrome label badge; unselected masks use dashed `--control` borders; background dims subtly. Below the video sits an **On-screen** visibility lane (`video.tracks[].visible`).
  - **Three stacked waveform lanes** (`144px` label column + full-width scrubbable canvas, `role="img"` + `aria-label`):
    1. **Full mix** (`S` solo button, waveform in `--rest` when audible, `--muted-wave` when muted)
    2. **Picked sound** (`--accent` dot, label + method `SAM Audio` / `Demucs`, `S` solo button, waveform in `--accent` when audible)
    3. **Rest of mix** (`S` solo button, waveform in `--rest` when audible)
- **Right inspector (`ISOLATE INSPECTOR`):**
  - `MUSE SPARK SUGGESTIONS`: clickable chips from `trackMap.suggestions`. Selecting a precomputed isolation switches immediately; selecting an uncomputed chip triggers `startIsolation` + `waitForJob`.
  - `DESCRIBE A SOUND`: text prompt input + `Isolate` button; shows exact mono prompt sent.
  - `IsolateProgress`: `listening → isolating → analyzing` mono stepper (`--accent` on current stage, `"Typically ~15–20 seconds"`).
  - `Cleaner version (Demucs)` checkbox toggle whenever a matching stem exists in `fallback_stems`.
  - Primary monochrome CTA `Continue to X-Ray →`.

### 3.3 X-Ray (`/c/[id]/xray`)

- **Center lanes:**
  - **4-stat strip:** `TEMPO` (`BPM`), `KEY` (`tonic mode`), `RANGE` (e.g. `A4–G5`), `ENTERS` (e.g. `Bar 9`).
  - **Four bar-aligned lanes (`88px` label column):**
    1. `Sections`: `trackMap.sections` blocks (`drop` highlighted).
    2. `Chords`: one mono cell per bar (`trackMap.chords`), clickable to seek to that bar.
    3. `Notes`: `MiniRoll` canvas (`isolation.notes`, active notes at playhead in `--accent`, others in `--text`).
    4. `Energy`: `trackMap.energy.values` line curve + playhead.
- **Right inspector (`X-RAY INSPECTOR`):**
  - `MUSE SPARK · SUMMARY`: concise musical summary of the isolated sound.
  - `RecipeCard` (`MUSE SPARK OPEN · SOUND RECIPE`): 2×2 parameter grid (`Oscillators`, `Filter`, `FX`, `Glide / Play`) + `AMP ENVELOPE` ADSR bars and mono values.
  - Primary CTA `Learn on keyboard →`.

### 3.4 Learn + Coach (`/c/[id]/learn`)

- **Center lanes:**
  - **Practice strip:** `Easy | Intermediate` arrangement toggle, problem-bar pill (`Bar N · late` in `--you`), `Hear: Sound | With mix`, and `MIDI input` selector (`On-screen + QWERTY` or connected Web MIDI device).
  - **`PianoRoll` canvas (`~260px` height, `--inset`):** bar gridlines, loop region shade, dashed `--you` outline on problem bar, reference right-hand notes (`--accent` when sounding, `--text` otherwise), left-hand `Intermediate` notes (`--left-hand`), user take dots (`--you`), crisp playhead, click to seek.
  - **`Keyboard` (`C4–B5`):** tactile monochrome two-octave piano keys (`--key-white` / `--key-black`) with QWERTY hints (`A`–`L`) and MIDI pitch labels; target notes currently sounding light up in `--accent`.
- **Right inspector (`VOICE COACH`):**
  - Feedback paragraph naming specific bars and timing/pitch offsets.
  - `APPLIED TOOL CALLS` mono log (`mark_problem_bar`, `set_loop`, `set_tempo`) that directly updates loop, tempo, and problem-bar state via `applyCoachAction()`.
  - `Analyze take` + `Hold to talk` controls.
  - `PER-BAR ACCURACY` 8-bar vertical chart (`--you` / `--accent` on problem bar) + browser-measurement footnote.

### 3.5 Take home (`/c/[id]/take`)

- **Center workspace:**
  - Eyebrow `05 · TAKE HOME`, title **"Export stems, MIDI & synth recipe."**, subtitle `"Aligned at {bpm} BPM in {key}."`
  - **`FileList` checklist:** `Isolated sound (.wav)`, `Rest of mix (.wav)`, `MIDI arrangement (.mid — Easy & Intermediate)`, `Sound recipe & chord sheet (.json + .txt)` with individual download actions and primary `Download ZIP · N files` bundle CTA.
- **Right inspector (`EXPORT INSPECTOR`):**
  - Session metadata (`BPM`, `Key`, `Method`, `Sample rate`) and compact `RecipeCard` recap.

---

## 4. Accessibility & Copy

- Real `<button>`, `<a>`, `<input>` + `<label>`; toggles and video masks use `aria-pressed`; icon buttons carry `aria-label`.
- Canvases (`WaveformLanes`, `MiniRoll`, `Energy`, `PianoRoll`, `AccuracyChart`) include `role="img"` and descriptive `aria-label` text.
- Text contrast ≥ 4.5:1 across all surfaces; never encode state by color alone.
- Copy stays concise, concrete, and musical (`Bar 9`, `A4–G5`, `SAM AUDIO · TEXT PROMPT`), with zero hype or emojis.
