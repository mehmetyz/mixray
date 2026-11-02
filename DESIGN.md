# Mixray — Design Spec

> UI reference for `apps/web`. Source of truth for colors, type, layout and the five screens.

**Look:** quiet monochrome DAW. Soft near-black neutral ground (`#131417`), thin `1px` hairlines (`#24262D`), soft off-white primary text (`#EAECEF`), cool neutral secondary copy, and a tiny surgical touch of orange (`#FF6A1A`) reserved strictly for precision indicators (wordmark `x`, active step dot, selected SAM 3.1 mask outline, active isolated waveform, sounding reference notes). Primary buttons and selected switches use crisp monochrome contrast (`--text` fill with `--bg` ink). A pale amber (`#F5B971`) marks `--you` (user take dots and the problem bar). No gradients, no glow washes, no emoji.

**Flow:** `Add → Isolate → Analyze → Practice → Export`.

**Honesty rule:** the screen only shows what was measured or produced for this clip. No fixed durations, no invented accuracy figures, no placeholder data standing in for real results.

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

1. **Header:** logo, the four steps, theme toggle.
2. **Left sidebar (`240px`, from 1280 px wide):** clip title with tempo and key, the clip's sounds with the method that produced each, and `New clip`. Narrower screens get the same title and sounds as one scrolling strip under the header, so tablets keep the room for the center; on a phone the steps also move to their own row under the logo, and the transport wraps instead of dropping rate and loop.
3. **Center stage:** bar and time ruler, then the lanes of the current step.
4. **Right inspector (`320px`):** only the current step's controls and results. Export has none.
5. **Transport (bottom, kept across steps so audio never stops):** return to start, play, position, `Sound | Rest | Full mix`, rate, and `Loop`, which loops four bars from the playhead.

---

## 3. Screens

### 3.0 Landing (`/`)

Public. Left: the tagline, one line on what Mixray does, and the access key, in plain text; a link `/?key=...` enters without typing it and stays on this page, with `Open the studio` in its place. Right: the café demo as Mixray really produced it. One sequence on load, and no other motion: each line of the tagline lights as the clip does that thing (the area drawn, the piano apart from the mix, its notes). `Full mix | Piano alone` plays the real audio. Below: the demo video once `MIXRAY_DEMO_VIDEO_URL` is set, the five steps, and what each model does. With reduced motion the final state shows at once.

### 3.1 Add (`/studio`, `/studio/new`)

One column, one job.

- `/studio` opens on the tagline and `New clip`, which goes to `/studio/new`, then `Demos`: six cards, each a still from the video, a `Real recording` or `AI-generated` label and one line on what it shows. A card is a shortcut to Add: it uploads that video through the normal flow with its sound already typed, and `/studio/new?demo=<id>` does the same from a link. In the studio a demo carries the same label and its credit under the clip title.
- Below the demos, `Your clips` lists the clips added in this browser, demos included, with a thumbnail: title, length, tempo, key, the sound, and the engine's live state (Checking, Working with its steps and time, Ready, Failed, Expired); `New clip` opens Add. A separation keeps running after the studio opens and resumes its progress on Isolate after a reload.

- Title and a line saying what to do. Drop zone with the real limits: `MP3, WAV, FLAC, MP4 or MOV. Up to 50 MB and 6 minutes.`
- Once a file is chosen: video preview, where dragging draws an area in `--accent` and a click plays or pauses; the `≤ 30 s` window on a waveform; an optional text field for the sound, hidden once an area is drawn.
- Rights checkbox with the contributor-mode disclosure, then `Continue`.
- While working: the current step, its number, and the seconds elapsed. No percentage, because the steps are not equal in length.

### 3.2 Isolate (`/c/[id]/pick`)

- **Center:** the video when there is one, where dragging draws an area and Muse Spark names it; under it a `Track` switch when the selected sound was chosen by area, which the first time asks SAM 3.1 to follow that area. Then one lane each for the sound, the rest and the full mix, with a solo button. Nothing is drawn before a sound exists.
- **Right:** text field, Muse Spark's suggestions, the current stage with seconds elapsed, the Demucs comparison when a matching stem exists, and `Continue to Analyze`.

### 3.3 Analyze (`/c/[id]/xray`)

- **Center:** the video, small enough to keep the notes on screen, with the same `Track` switch as Isolate. Then tempo, key, range and first note; a chord lane where a click seeks; the note roll.
- **Right:** Muse Spark's summary, a line saying readings are automatic and may be wrong, the sound recipe, `Practice on keys`.

### 3.4 Practice (`/c/[id]/learn`)

- **Center:** `Easy | Intermediate`, MIDI input, the problem bar when the coach marks one. Piano roll with the part and your take. Keyboard `C4–B5` with `A`–`L` hints and which sound the keys play.
- **Right:** the talk button, because both hands are on the keys: a sustain pedal or any drum pad by default, or a control the player chooses, plus `V` and an on-screen `Talk` button. A press opens the microphone for one phrase and turns the track down; the phrase goes to Muse Voice Transcribe and the microphone closes. Meta has no text-to-speech, so replies are a short sound and a line on screen saying what was heard and what changed; a typed command is the fallback. Also the coach's messages, your take's hit rate and timing, `Get feedback`, `What you can say`, `Continue to Export`.

### 3.5 Export (`/c/[id]/take`)

No timeline, because nothing here plays against time. A checklist where each row says what it holds and names its real files (sound, rest of the mix, MIDI when the sound has notes, recipe and session notes), and one download button that counts the files in the ZIP.

---

## 4. Accessibility & Copy

- Real `<button>`, `<a>`, `<input>` + `<label>`; toggles and video masks use `aria-pressed`; icon buttons carry `aria-label`.
- Canvases (`WaveformLanes`, `MiniRoll`, `Energy`, `PianoRoll`, `AccuracyChart`) include `role="img"` and descriptive `aria-label` text.
- Text contrast ≥ 4.5:1 across all surfaces; never encode state by color alone.
- Copy stays concise, concrete, and musical (`Bar 9`, `A4–G5`, `SAM AUDIO · TEXT PROMPT`), with zero hype or emojis.
