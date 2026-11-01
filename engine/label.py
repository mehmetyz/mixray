"""Name the prominent sound source in a selected video region for SAM Audio.

Visual masks make a useful overlay, but using them directly as an audio-separation prompt is slow
and lets nearby sources leak through. This module crops the selected region, asks Muse Spark
what it shows, and turns that answer into the concise text prompt SAM Audio separates well.
"""

import json
import logging
import re
import subprocess
import tempfile
from pathlib import Path
from typing import TypedDict

import meta_api

LOGGER = logging.getLogger(__name__)

LABEL_MODEL = "muse-spark-1.2-contributor"
MAX_OUTPUT_TOKENS = 4000
MAX_LABEL_WORDS = 3
# Acronyms a display label keeps upper case; everything else is title-cased word by word.
ACRONYMS = frozenset({"midi", "dj", "tr", "fm", "sfx"})
MAX_LABEL_LENGTH = 48
MAX_PROMPT_LENGTH = 48

LABEL_INSTRUCTION = (
    "What musical instrument or sound source is shown in this image? Identify the single most "
    "prominent one and return JSON only. `prompt` must be one to three lowercase words naming the "
    "kind of instrument or sound: no sentence, markdown, brand or model name, or punctuation. "
    "`label` must name the same thing in Title Case, with at most three words and no slashes. "
    'Examples: {"label": "Electronic Keyboard", "prompt": "electronic keyboard"}; '
    '{"label": "Grand Piano", "prompt": "grand piano"}; '
    '{"label": "Snare Drum", "prompt": "snare drum"}.'
)


class RegionLabel(TypedDict):
    """A button label and its matching SAM Audio text prompt."""

    label: str
    prompt: str


class RegionBounds(TypedDict):
    """The selected rectangle's pixel coordinates in the full video frame."""

    left: int
    top: int
    right: int
    bottom: int


LabelFixture = tuple[str, RegionLabel]


LABEL_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["label", "prompt"],
    "properties": {
        "label": {
            "type": "string",
            "maxLength": MAX_LABEL_LENGTH,
            "description": (
                "The same instrument or sound as prompt, in Title Case, with one to three words "
                "and no slashes or punctuation."
            ),
        },
        "prompt": {
            "type": "string",
            "maxLength": MAX_PROMPT_LENGTH,
            "description": (
                "One to three lowercase words naming the instrument or sound; no sentence, "
                "markdown, brand, model name, or punctuation."
            ),
        },
    },
}

LABEL_FIXTURES: tuple[LabelFixture, ...] = (
    (
        '{"label": "Piano / Electronic Keyboard", "prompt": "The most prominent sound '
        "source shown is a **Piano-style Keyboard - Electronic / MIDI Controller Keyboard** - "
        'black and white piano keys."}',
        {"label": "Piano Style Keyboard", "prompt": "piano style keyboard"},
    ),
    (
        '{"label": "MIDI/Electronic Keyboard"}',
        {"label": "MIDI Electronic Keyboard", "prompt": "midi electronic keyboard"},
    ),
    (
        '{"label": "MIDI Controller Keyboard", "prompt": "The image shows an **ARTURIA '
        "MiniLab 3 - 25-key USB MIDI Controller Keyboard** - a compact electronic/MIDI keyboard "
        'controller."}',
        {"label": "MIDI Controller Keyboard", "prompt": "midi controller keyboard"},
    ),
)


def _crop_filter(bounds: RegionBounds) -> str:
    """Validate one full-frame rectangle and return its ffmpeg crop filter."""
    coordinates = (bounds["left"], bounds["top"], bounds["right"], bounds["bottom"])
    if any(isinstance(value, bool) or not isinstance(value, int) for value in coordinates):
        raise ValueError("region bounds must be integers")

    left, top, right, bottom = coordinates
    if left < 0 or top < 0 or right <= left or bottom <= top:
        raise ValueError("region bounds are invalid")
    return f"crop={right - left}:{bottom - top}:{left}:{top}"


def crop_region(frame_path: Path, bounds: RegionBounds, destination: Path) -> None:
    """Crop one selected full-frame region to a PNG with ffmpeg."""
    if not frame_path.is_file():
        raise FileNotFoundError(f"frame does not exist: {frame_path}")
    if destination.suffix.lower() != ".png":
        raise ValueError("crop destination must be a PNG")

    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(frame_path),
            "-vf",
            _crop_filter(bounds),
            "-frames:v",
            "1",
            str(destination),
        ],
        check=True,
        capture_output=True,
    )


def _valid_prompt(value: object) -> str | None:
    """Return a SAM Audio-ready lowercase noun phrase, or None when malformed."""
    if (
        not isinstance(value, str)
        or value != value.strip()
        or value != value.lower()
        or len(value) > MAX_PROMPT_LENGTH
    ):
        return None
    words = value.split()
    if not 1 <= len(words) <= MAX_LABEL_WORDS or not all(word.isalnum() for word in words):
        return None
    return value


def _normalise_prompt(value: object) -> str | None:
    """Recover a short SAM Audio prompt from a verbose model field."""
    if not isinstance(value, str):
        return None
    shortened = value.split("(", maxsplit=1)[0].split(" - ", maxsplit=1)[0]
    words = re.findall(r"[^\W_]+", shortened.lower())
    return _valid_prompt(" ".join(words[-MAX_LABEL_WORDS:]))


def _title_label(prompt: str) -> str:
    """Make a display label from a validated prompt.

    `str.title` writes a lowercased acronym back as a word, so "midi keyboard" would reach a button
    as "Midi Keyboard". Instrument names carry a handful of acronyms; they stay upper case.
    """
    return " ".join(word.upper() if word in ACRONYMS else word.title() for word in prompt.split())


def parse_label(raw: str) -> RegionLabel:
    """Validate and recover a structured Muse Spark reply before exposing its prompt."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("label reply was not valid JSON") from error
    if not isinstance(parsed, dict):
        raise RuntimeError("label reply did not have the expected fields")

    label_value = parsed.get("label")
    prompt_value = parsed.get("prompt")
    prompt = _valid_prompt(prompt_value)
    if prompt is None:
        prompt = _normalise_prompt(prompt_value)
        if prompt is None or any(character.isdigit() for character in prompt):
            prompt = _normalise_prompt(label_value)
    if prompt is None:
        raise RuntimeError("label reply had no usable label or prompt")
    # The label is always derived rather than taken from the reply, so the chip and the separation
    # prompt can never name two different sounds, and acronyms are cased once in one place.
    return {"label": _title_label(prompt), "prompt": prompt}


def check_label_fixtures() -> None:
    """Raise when parser recovery no longer handles the recorded API replies."""
    for raw, expected in LABEL_FIXTURES:
        actual = parse_label(raw)
        if actual != expected:
            raise AssertionError(f"expected {expected}, got {actual}")


def label_region(frame_path: Path, bounds: RegionBounds, api_key: str) -> RegionLabel:
    """Crop a selected frame region and name its most prominent sound source once."""
    if not api_key.strip():
        raise RuntimeError("META_API_KEY is not set")

    with tempfile.TemporaryDirectory(prefix="mixray-label-") as temporary_directory:
        crop_path = Path(temporary_directory) / "region.png"
        crop_region(frame_path, bounds, crop_path)
        payload: dict[str, object] = {
            "model": LABEL_MODEL,
            "max_output_tokens": MAX_OUTPUT_TOKENS,
            "input": [
                {
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": LABEL_INSTRUCTION},
                        {
                            "type": "input_image",
                            "image_url": meta_api.data_url(crop_path, "image/png"),
                        },
                    ],
                }
            ],
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": "region_label",
                    "schema": LABEL_SCHEMA,
                    "strict": True,
                }
            },
        }
        raw = meta_api.output_text(meta_api.post_responses(payload, api_key))
    result = parse_label(raw)
    LOGGER.info("labelled selected region as %s", result["prompt"])
    return result


if __name__ == "__main__":
    check_label_fixtures()
