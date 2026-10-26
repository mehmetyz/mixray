# Mixray

**See inside any song.** Drop in a track you own, and Mixray splits it into its parts, shows you what is inside (tempo, key, chords, sections, the hook), teaches you to play it on a MIDI keyboard with a Muse-powered coach, and hands you a kit to rebuild it in your DAW.

Built for the **Meta Global AI Developer Hackathon** (Oct 26 – Nov 4, 2026).

## Meta models

- **Muse Spark**: listens to the reference and your take, gives feedback, and drives the practice session with tool calls
- **Muse Voice Transcribe**: hands-free commands while you play
- **Muse Spark Open** (self-hosted on Modal): Sound Recipe for each instrument

Open-source signal models: Demucs (stem separation) and Basic Pitch (audio to MIDI).

## Built during the hackathon

All code in this repository was written during the hackathon. Model feasibility tests were done beforehand and are not part of this repo.

## Run locally

```bash
# web
cd apps/web && pnpm install && pnpm dev

# engine (needs a Modal account and the `mixray-secrets` secret)
cd engine && uv sync && uv run modal serve app.py
```

Upload only music you own or have the rights to.
