# Mixray

**Point at a sound. Hear it alone. Learn to play it.**

Drop in a track or a video you own, pick one sound out of the mix — by typing what you want, by
taking a suggestion, or by drawing over the instrument in the video — and Mixray isolates it, shows
what it plays, and teaches you to play it on a keyboard with a coach that listens to your take.

Built for the **Meta Global AI Developer Hackathon** (Oct 26 – Nov 4, 2026).

## Meta models

- **SAM Audio** (open weights, self-hosted on Modal): prompted sound separation — the core of the product
- **SAM 3.1**: follows a selected instrument through the video as a Track overlay on the Analyze screen
- **Muse Spark**: listens to the clip, suggests sounds worth isolating, and coaches the practice session through tool calls
- **Muse Spark Open** (open weights, via Baseten partner inference): the Sound Recipe for each isolated sound
- **Muse Voice Transcribe**: hands-free commands while both hands are on the keys

Supporting open-source signal models: **Demucs** (fallback separation for standard stems) and
**Basic Pitch** (audio to MIDI).

## How it fits together

See [ARCHITECTURE.md](ARCHITECTURE.md).

## Run locally

```bash
# web
cd apps/web && pnpm install && pnpm dev

# engine (needs a Modal account and the mixray-secrets, mixray-hf and mixray-baseten secrets)
cd engine && uv sync && uv run modal deploy app.py
```

Set the variables listed in `.env.example`. The browser never sees a model key: every model call
goes through a server route or Modal.

## Rights

All code in this repository was written during the hackathon. Upload only music or video you own
or have the rights to; third-party media used in the demo is listed in [CREDITS.md](CREDITS.md)
with its licence and author.
