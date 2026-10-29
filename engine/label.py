"""Name the prominent sound source in a selected video region for SAM Audio.

Visual masks make a useful tap overlay, but using them directly as an audio-separation prompt is
slow and lets nearby sources leak through. This module crops the selected region, asks Muse Spark
what it shows, and turns that answer into the concise text prompt SAM Audio separates well.
"""

import json
import logging
import subprocess
import tempfile
from pathlib import Path
from typing import TypedDict

import meta_api

LOGGER = logging.getLogger(__name__)

LABEL_MODEL = "muse-spark-1.2-contributor"
MAX_OUTPUT_TOKENS = 4000
MAX_LABEL_WORDS = 3

LABEL_INSTRUCTION = (
    "What musical instrument or sound source is shown in this image? "
    "Answer with the single most prominent one."
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


LABEL_SCHEMA: dict[str, object] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["label", "prompt"],
    "properties": {
        "label": {"type": "string", "description": "Title case, at most three words."},
        "prompt": {
            "type": "string",
            "description": "Lowercase noun phrase, with no verbs or punctuation.",
        },
    },
}


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


def _valid_label(value: object) -> str | None:
    """Return a button-safe Title case label, or None when the reply is malformed."""
    if not isinstance(value, str) or value != value.strip():
        return None
    words = value.split()
    if not 1 <= len(words) <= MAX_LABEL_WORDS or value != value.title():
        return None
    if not all(word.isalnum() for word in words):
        return None
    return value


def _valid_prompt(value: object) -> str | None:
    """Return a SAM Audio-ready lowercase noun phrase, or None when malformed."""
    if not isinstance(value, str) or value != value.strip() or value != value.lower():
        return None
    words = value.split()
    if not words or not all(word.isalnum() for word in words):
        return None
    return value


def parse_label(raw: str) -> RegionLabel:
    """Validate a structured Muse Spark reply before exposing it as a separation prompt."""
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise RuntimeError("label reply was not valid JSON") from error
    if not isinstance(parsed, dict) or set(parsed) != {"label", "prompt"}:
        raise RuntimeError("label reply did not have the expected fields")

    label = _valid_label(parsed["label"])
    prompt = _valid_prompt(parsed["prompt"])
    if label is None or prompt is None:
        raise RuntimeError("label reply had an invalid label or prompt")
    return {"label": label, "prompt": prompt}


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
