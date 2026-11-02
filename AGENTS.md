# AGENTS.md

Mixray: point at a sound in a song or video, hear it alone, see what it plays, learn it on a
keyboard. The full engineering spec is in `SPEC.md`; read it before starting any task. Read
`DESIGN.md` before any UI work. Work items are in `TASKS.md`. Decisions and current state are in
`CONTEXT.md`; update its "State" section when a milestone closes.

## How to work

- Do **one milestone at a time** (M0, M1, …) as named in `SPEC.md`. Stop when its "done when"
  criterion is met and report.
- Do exactly one task per run, in order, unless another is named.
- Make the **smallest change** that meets the goal. No refactors, renames or cleanups that were not
  asked for.
- Prefer editing existing files over creating new ones.
- If something is ambiguous, pick the simplest option, note the assumption in the final message,
  and continue.
- After each change, run the relevant check (see Commands). **Never report success on code that was
  not run.**
- A task is done when its **Done when** check passes and it has been run. Then tick it (`- [x]`) in
  `TASKS.md`.
- If a task is blocked, write `BLOCKED: <reason>` under it and stop.
- Never let two parallel changes touch the same file. Whoever holds a task owns its files until it
  is done.
- When a task needs both logic and UI, the logic and the types land first; the UI is built against
  them.

## Git

- One branch: `master`. No PR or branch sprawl.
- Commit each meaningful unit of work; use Conventional Commits in English: `feat: add ...`,
  `fix: ...`, `chore: ...`, `docs: ...`, `refactor: ...`.
- Never stage secrets, `.env*` files (except `.env.example`), audio we do not own, or model weights.

## Supply chain

- Never execute packages straight from a registry: no `npx`, `pnpx`, `pnpm dlx`, `bunx`, `uvx`,
  `create-*` scaffolders, `curl … | sh`.
- Use the latest stable version of every dependency; hold one back only when a peer range forces it,
  and note why.
- Write config files by hand, pin **exact** versions in `package.json` / `pyproject.toml`, install
  with `pnpm install` / `uv sync`, and run tools through package scripts or `uv run`.
- Keep pnpm's lifecycle-script block on; allow a dependency's install script only via
  `pnpm.onlyBuiltDependencies` with a reason.

## Project layout

```
apps/web/                 Next.js (App Router, TypeScript, Tailwind). UI, Web Audio, Web MIDI, /api routes
engine/                   Python, Modal app: ingest, suggest, track, isolate, fallback, analyze, transcribe, arrange, recipe, voice proxy
schema/trackmap.schema.json   the ONLY contract between engine and web
scripts/                  one-off tools
evaluation/               how the figures in the README were measured
SPEC.md  AGENTS.md  ARCHITECTURE.md  README.md
```

Keep this layout. Do not add new top-level folders, a database, or a second frontend.

## Commands

```bash
# web
cd apps/web && pnpm install && pnpm dev          # http://localhost:3000
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # check before reporting

# engine
cd engine && uv sync
uv run modal serve app.py                        # dev, hot reload
uv run modal deploy app.py                       # deploy
uv run --all-groups ruff format . && uv run --all-groups ruff check . && uv run --all-groups mypy .
uv run --all-groups pytest && uv run --all-groups python transcribe.fixture.py   # check before reporting
```

## Code style

### TypeScript / React
- Strict TypeScript. Server components by default; `"use client"` only where audio/MIDI/canvas need it.
- Audio, MIDI and canvas logic lives in plain modules under `apps/web/lib/`, not inside components.
- Tailwind for styling, CSS variables for theme colors. No UI kit unless asked.
- Every fetch and every API route validates input and fails gracefully with a short visible message.

### Python
- Python 3.11, type hints on all function signatures.
- Small functions, early returns, constants in UPPER_CASE at the top.
- `logging`, not `print`. Never log secrets or full tokens.
- Every Modal function sets `timeout` and the smallest GPU that works. Heavy imports inside the
  function, not at module top.
- Catch errors at the boundary (endpoint / function), log, return a short error the UI can show.
  No silent `except: pass`.

### Both
- SOLID, DRY, KISS: one responsibility per module, shared types and helpers instead of copies, the
  simplest design that works.
- Everything is precisely typed. TypeScript: no `any`, no `as unknown as`, no non-null `!` to
  silence the compiler; narrow with type guards and validate untrusted data at the boundary. Python:
  full type hints, no `cast()` or `# type: ignore` unless a third-party stub forces it (then explain
  why in one line).
- No nested type definitions: every object, enum union and tuple gets its own named type and is
  referenced by name. In `schema/trackmap.schema.json` every nested object or enum lives in `$defs`
  with a `title`, so generated types stay flat.
- All code, comments, docs and commit messages are in English.
- Clear names over comments; comment only the "why".
- No dead code, no commented-out blocks, no TODOs left behind.

## Models and dependencies

- **Runtime AI goes only to Meta models**: SAM Audio (self-hosted), SAM 3.1, Muse Spark, Muse Spark
  Open, Muse Voice Transcribe. Never call a non-Meta model API at runtime.
- Supporting open-source signal models: **Demucs** (the route for drums, organ, synth and speech, and the fallback when SAM Audio returns nothing) and **Basic Pitch**
  (transcription).
- Each heavy model gets its own Modal image (SAM Audio, Demucs and Basic Pitch have conflicting
  numpy/protobuf needs). Read `SPEC.md` §7 before touching SAM Audio.
- Allowed libraries: Next.js, React, Tailwind, `@tonejs/midi`, `jszip`; Python: `modal`,
  `sam-audio` (+ its torch/torchaudio deps), `demucs`, `basic-pitch`, `librosa`, `numpy`,
  `soundfile`, `pretty_midi`, `fastapi`, `httpx`, `ffmpeg` (binary).
- Do not add anything else without stating why in the final message.
- Verify Meta model IDs, endpoints and request formats in the official docs before use. Do not guess.

## Security

- Secrets live in Modal Secrets, Vercel env vars and local `.env` / `.env.local`. Never hard-code,
  print or commit keys. Never read or modify `.env` or `.env.*` contents.
- The browser never sees a model key; all model calls go through server routes or Modal.
- Enforce the cost guards in `SPEC.md` §4 (30 s clip, size limits, frame cap, cache, per-IP quota).

## Do not

- Do not use or commit copyrighted audio or video (no film scenes, no commercial songs). Demo
  content must be owned or CC-licensed with attribution.
- Do not add auth, a database, payments, Electron or a mobile app.
- Do not change `schema/trackmap.schema.json` or the Coach tool names in `SPEC.md` without updating
  both engine and web in the same change.
