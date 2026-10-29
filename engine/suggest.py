"""Ask Muse Spark what it hears in a clip, and turn that into pickable suggestion chips.

The Pick screen currently offers the same four hardcoded chips for every clip. This replaces them
with the sounds that are actually in the recording, each carrying the text prompt SAM Audio should
be given for it.

Three findings from `SPEC.md` §9 shape the whole module, and all three were measured rather than
assumed:

* `input_audio` is silently dropped - the request succeeds, the token count does not move and the
  model answers that it was given no audio. Audio has to travel inside an mp4 as `input_video`.
* That mp4's picture must not be blank. With black frames only 2 of 5 runs heard the audio; with the
  waveform drawn into it, 5 of 5 did. The prompt must also never mention the picture, because
  telling the model to ignore it brings the refusal straight back.
* Structured output is unreliable while audio is attached, so this runs two calls: one that listens
  and answers in plain prose, and a second, audio-free one that turns that prose into JSON.
"""

import json
import logging
import subprocess
from pathlib import Path
from typing import TypedDict

import modal

import meta_api
from images import web_image
from ingest import clip_dir, get_cache_root

LOGGER = logging.getLogger(__name__)

app = modal.App("mixray-suggest")

CACHE_VOLUME = modal.Volume.from_name("mixray-cache", create_if_missing=True)
CACHE_PATH = "/cache"

SUGGEST_TIMEOUT_SECONDS = 300
API_SECRET = modal.Secret.from_name("mixray-secrets")

# 1.2, not 1.3: the docs say audio understanding in 1.3 is not fully supported and may be degraded.
# Contributor mode is the production default, as CONTEXT.md decided and the Add screen discloses.
# Callers may pass the standard model instead, which costs roughly twelve times as much but keeps
# the request out of Meta's training data - worth it when the audio is not ours to contribute.
LISTEN_MODEL = "muse-spark-1.2-contributor"
STRUCTURE_MODEL = "muse-spark-1.2-contributor"
STANDARD_MODEL = "muse-spark-1.2"
# Reasoning shares the output budget, so a small cap can return an empty answer.
MAX_OUTPUT_TOKENS = 4000

WAVEFORM_SIZE = "320x180"
WAVEFORM_RATE = 5
MIN_SUGGESTIONS = 3
MAX_SUGGESTIONS = 6

# Lowercase noun phrases, because SAM Audio was trained on them: its README asks for "thunder"
# rather than "thunder can be heard in the background".
LISTEN_INSTRUCTION = (
    "This is a music clip. Listen to it and describe, in plain prose, each distinct sound you can "
    "hear - instruments, voices, drums, textures. For each one say what it is and how it behaves "
    "in the mix. Then give one sentence describing the clip as a whole: its genre, tempo feel and "
    "mood. Be concrete and only name sounds you actually hear."
)

# The mp4 workaround is not reliable every time. A run that fails comes back describing the picture
# or denying there was any audio, and it does so in a perfectly well-formed reply, so shape
# validation lets it through: one such run produced the chips "No Audible Audio" and "Waveform
# Image Only". These are the words those failures use; seeing any of them means the model never
# heard the clip, and the only fix is to ask again.
DEAF_MARKERS = (
    "waveform",
    "no audible",
    "no audio",
    "cannot hear",
    "can't hear",
    "unable to hear",
    "black background",
    "black screen",
    "text-based",
    "silent display",
)
STRUCTURE_INSTRUCTION = (
    "Turn the following description of a music clip into JSON. Produce between "
    f"{MIN_SUGGESTIONS} and {MAX_SUGGESTIONS} suggestions, one per distinct sound, ordered by how "
    "prominent the sound is. `label` is a short title for a button, in Title case, at most three "
    "words. `prompt` is the same sound written as a lowercase noun phrase for an audio separation "
    "model, such as 'synth lead' or 'kick drum' - no verbs, no sentence, no punctuation. `summary` "
    "is the single sentence describing the whole clip."
)


class Suggestion(TypedDict):
    """One chip on the Pick screen: what to show, and what to ask SAM Audio for."""

    label: str
    prompt: str


class ClipSuggestions(TypedDict):
    """Everything `suggest` contributes to a trackmap."""

    suggestions: list[Suggestion]
    summary: str


SUGGESTION_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["suggestions", "summary"],
    "properties": {
        "suggestions": {
            "type": "array",
            "minItems": MIN_SUGGESTIONS,
            "maxItems": MAX_SUGGESTIONS,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["label", "prompt"],
                "properties": {"label": {"type": "string"}, "prompt": {"type": "string"}},
            },
        },
        "summary": {"type": "string"},
    },
}


def waveform_mp4(wav_path: Path, mp4_path: Path) -> None:
    """Wrap the audio in an mp4 whose picture is its own waveform.

    Both streams are given the same explicit duration: `-shortest` against a generated video source
    once left a 41 s picture over 30 s of audio.
    """
    argv = [
        "ffmpeg",
        "-y",
        "-i",
        str(wav_path),
        "-filter_complex",
        f"[0:a]showwaves=s={WAVEFORM_SIZE}:mode=line:rate={WAVEFORM_RATE}[v]",
        "-map",
        "[v]",
        "-map",
        "0:a",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        str(mp4_path),
    ]
    subprocess.run(argv, check=True, capture_output=True)


def heard_audio(description: str) -> bool:
    """True when the reply describes sound rather than denying there was any."""
    lowered = description.lower()
    return not any(marker in lowered for marker in DEAF_MARKERS)


def listen_to_clip(mp4_path: Path, api_key: str, model: str = LISTEN_MODEL) -> str:
    """Ask the model what it hears, in prose, until it actually hears something.

    The picture is never mentioned, by design: telling the model to ignore it reliably brings back
    the refusal this retries around.
    """
    payload: dict[str, object] = {
        "model": model,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": LISTEN_INSTRUCTION},
                    # The media source sits directly on the part, and inline base64 travels as a
                    # data URL: an `input_video` carrying a `data` field is rejected with
                    # "input_video content part requires `video_url` or `file_id`".
                    {"type": "input_video", "video_url": meta_api.data_url(mp4_path, "video/mp4")},
                ],
            }
        ],
    }
    for attempt in range(1, meta_api.ATTEMPTS + 1):
        description = meta_api.output_text(meta_api.post_responses(payload, api_key))
        if heard_audio(description):
            return description
        LOGGER.warning(
            "attempt %d/%d did not hear the clip: %s", attempt, meta_api.ATTEMPTS, description[:120]
        )
    raise RuntimeError(f"Muse Spark did not hear the clip in {meta_api.ATTEMPTS} attempts")


def structure_description(
    description: str, api_key: str, model: str = STRUCTURE_MODEL
) -> ClipSuggestions:
    """Turn the prose description into chips. No audio here, so strict JSON is safe."""
    payload: dict[str, object] = {
        "model": model,
        "max_output_tokens": MAX_OUTPUT_TOKENS,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": f"{STRUCTURE_INSTRUCTION}\n\n{description}"}
                ],
            }
        ],
        "text": {
            "format": {
                "type": "json_schema",
                "name": "clip_suggestions",
                "schema": SUGGESTION_SCHEMA,
                "strict": True,
            }
        },
    }
    return parse_suggestions(meta_api.output_text(meta_api.post_responses(payload, api_key)))


def parse_suggestions(raw: str) -> ClipSuggestions:
    """Validate the model's JSON at the boundary before any of it reaches a trackmap."""
    parsed = json.loads(raw)
    if not isinstance(parsed, dict):
        raise RuntimeError("suggestions reply was not an object")
    summary = parsed.get("summary")
    items = parsed.get("suggestions")
    if not isinstance(summary, str) or not isinstance(items, list):
        raise RuntimeError("suggestions reply was missing summary or suggestions")

    suggestions: list[Suggestion] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        label, prompt = item.get("label"), item.get("prompt")
        if not isinstance(label, str) or not isinstance(prompt, str):
            continue
        cleaned = prompt.strip().lower().rstrip(".")
        if label.strip() and cleaned:
            suggestions.append({"label": label.strip(), "prompt": cleaned})
    if len(suggestions) < MIN_SUGGESTIONS:
        raise RuntimeError(f"only {len(suggestions)} usable suggestions came back")
    return {"suggestions": suggestions[:MAX_SUGGESTIONS], "summary": summary.strip()}


def suggest_clip(
    clip_id: str, cache_root: Path | None = None, model: str = LISTEN_MODEL
) -> ClipSuggestions:
    """Listen to a cached clip and write its chips to the clip's own sidecar."""
    root = cache_root if cache_root is not None else get_cache_root()
    directory = clip_dir(clip_id, root)
    wav_path = directory / "mix_mono.wav"
    if not wav_path.exists():
        raise FileNotFoundError(f"no mono mix for clip {clip_id}: {wav_path}")

    mp4_path = directory / "suggest_input.mp4"
    waveform_mp4(wav_path, mp4_path)
    api_key = meta_api.api_key()
    described = listen_to_clip(mp4_path, api_key, model)
    LOGGER.info("muse spark heard: %s", described[:200])
    result = structure_description(described, api_key, model)
    (directory / "suggest.json").write_text(json.dumps(result), encoding="utf-8")
    LOGGER.info("suggested %d sounds for clip=%s", len(result["suggestions"]), clip_id)
    return result


@app.function(
    image=web_image,
    volumes={CACHE_PATH: CACHE_VOLUME},
    secrets=[API_SECRET],
    timeout=SUGGEST_TIMEOUT_SECONDS,
    gpu=None,
)
def suggest_worker(clip_id: str, model: str = LISTEN_MODEL) -> ClipSuggestions:
    """Muse Spark is an HTTP call, so this needs no GPU and no model image."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        return suggest_clip(clip_id, model=model)
    finally:
        CACHE_VOLUME.commit()
