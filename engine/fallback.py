"""Create cached Demucs stems for prompts that name a standard instrument.

SAM Audio remains Mixray's primary separator because it accepts arbitrary prompts. This module only
offers Demucs' fixed, cleaner alternatives for prompts that map to one of its six standard stems.
"""

from __future__ import annotations

import audioop
import json
import logging
import re
import subprocess
import sys
import wave
from pathlib import Path
from typing import Literal, TypedDict

import modal

from images import demucs_image
from ingest import clip_dir, encode_mp3, get_cache_root

LOGGER = logging.getLogger(__name__)

app = modal.App("mixray-fallback")

FALLBACK_TIMEOUT_SECONDS = 900
DEMUCS_COMMAND_TIMEOUT_SECONDS = 840
DEMUCS_MODEL = "htdemucs_6s"
DEMUCS_DEVICE = "cpu"
FALLBACK_DIRECTORY_NAME = "fallback"
WAV_EXTENSION = ".wav"
MP3_EXTENSION = ".mp3"

StemName = Literal["vocals", "drums", "bass", "guitar", "piano", "other"]
StemNames = tuple[StemName, ...]
StemKeywordMatch = tuple[StemName, frozenset[str]]
StemKeywordMatches = tuple[StemKeywordMatch, ...]
StemRms = dict[StemName, float]
FallbackStems = list["FallbackStem"]

# Keep this order aligned with the schema's StemName enum and the htdemucs_6s source names.
STEM_NAMES: StemNames = ("vocals", "drums", "bass", "guitar", "piano", "other")
PROMPT_STEM_KEYWORDS: StemKeywordMatches = (
    ("vocals", frozenset({"vocal", "vocals", "voice", "sing", "singing", "singer"})),
    ("drums", frozenset({"drum", "drums", "kick", "snare", "hihat", "hat", "cymbal"})),
    ("bass", frozenset({"bass", "sub", "subbass"})),
    ("guitar", frozenset({"guitar", "guitars"})),
    ("piano", frozenset({"piano", "keys", "keyboard"})),
)
PROMPT_TOKEN_PATTERN = re.compile(r"[a-z]+")


class FallbackStem(TypedDict):
    """One cached Demucs alternative, matching the schema's FallbackStem object."""

    name: StemName
    url: str
    wav_url: str
    level: float


def stem_for_prompt(prompt: str) -> StemName | None:
    """Return the standard Demucs stem named by a natural-language prompt, if any."""
    prompt_tokens = frozenset(PROMPT_TOKEN_PATTERN.findall(prompt.lower()))
    for stem, keywords in PROMPT_STEM_KEYWORDS:
        if prompt_tokens.intersection(keywords):
            return stem
    return None


def _fallback_directory(clip_id: str, cache_root: Path) -> Path:
    return clip_dir(clip_id, cache_root) / FALLBACK_DIRECTORY_NAME / DEMUCS_MODEL


def _stem_wav_path(clip_id: str, stem: StemName, cache_root: Path) -> Path:
    return _fallback_directory(clip_id, cache_root) / f"{stem}{WAV_EXTENSION}"


def _stem_mp3_path(clip_id: str, stem: StemName, cache_root: Path) -> Path:
    return _fallback_directory(clip_id, cache_root) / f"{stem}{MP3_EXTENSION}"


def _stem_url(clip_id: str, stem: StemName, extension: str) -> str:
    return f"/files/clips/{clip_id}/{FALLBACK_DIRECTORY_NAME}/{DEMUCS_MODEL}/{stem}{extension}"


def _all_wavs_exist(clip_id: str, cache_root: Path) -> bool:
    return all(_stem_wav_path(clip_id, stem, cache_root).exists() for stem in STEM_NAMES)


def _run_demucs(clip_id: str, cache_root: Path) -> None:
    """Run the six-source model once unless every cached WAV stem is already present."""
    if _all_wavs_exist(clip_id, cache_root):
        return

    mix_wav = clip_dir(clip_id, cache_root) / "mix.wav"
    if not mix_wav.exists():
        raise FileNotFoundError(f"no mix for clip {clip_id}: {mix_wav}")

    output_root = _fallback_directory(clip_id, cache_root).parent
    output_root.mkdir(parents=True, exist_ok=True)
    # htdemucs_6s is the six-source model: the ordinary htdemucs model omits piano and guitar.
    argv = [
        sys.executable,
        "-m",
        "demucs.separate",
        "--name",
        DEMUCS_MODEL,
        "--device",
        DEMUCS_DEVICE,
        "--out",
        str(output_root),
        "--filename",
        "{stem}.{ext}",
        str(mix_wav),
    ]
    LOGGER.info("running Demucs fallback for clip=%s", clip_id)
    subprocess.run(argv, check=True, timeout=DEMUCS_COMMAND_TIMEOUT_SECONDS)

    missing_stems = [
        stem for stem in STEM_NAMES if not _stem_wav_path(clip_id, stem, cache_root).exists()
    ]
    if missing_stems:
        missing = ", ".join(missing_stems)
        raise RuntimeError(f"Demucs did not produce stems: {missing}")


def _rms(wav_path: Path) -> float:
    """Return the PCM RMS for a WAV stem, or zero for a silent stem."""
    with wave.open(str(wav_path), "rb") as wav_file:
        frames = wav_file.readframes(wav_file.getnframes())
        sample_width = wav_file.getsampwidth()
    if not frames:
        return 0.0
    return float(audioop.rms(frames, sample_width))


def _normalised_rms(clip_id: str, cache_root: Path) -> StemRms:
    rms_by_stem = {stem: _rms(_stem_wav_path(clip_id, stem, cache_root)) for stem in STEM_NAMES}
    loudest_rms = max(rms_by_stem.values(), default=0.0)
    if loudest_rms <= 0.0:
        return {stem: 0.0 for stem in STEM_NAMES}
    return {
        stem: round(min(1.0, max(0.0, rms / loudest_rms)), 6) for stem, rms in rms_by_stem.items()
    }


def separate_clip(clip_id: str, cache_root: Path | None = None) -> FallbackStems:
    """Separate a clip once, encode each stem for playback, and return schema-valid entries."""
    root = cache_root if cache_root is not None else get_cache_root()
    _run_demucs(clip_id, root)

    for stem in STEM_NAMES:
        wav_path = _stem_wav_path(clip_id, stem, root)
        mp3_path = _stem_mp3_path(clip_id, stem, root)
        if not mp3_path.exists():
            encode_mp3(wav_path, mp3_path)

    levels = _normalised_rms(clip_id, root)
    return [
        {
            "name": stem,
            "url": _stem_url(clip_id, stem, MP3_EXTENSION),
            "wav_url": _stem_url(clip_id, stem, WAV_EXTENSION),
            "level": levels[stem],
        }
        for stem in STEM_NAMES
    ]


def write_fallback_stems(
    clip_id: str, fallback_stems: FallbackStems, cache_root: Path | None = None
) -> None:
    """Write the producer-owned fallback stems sidecar."""
    root = cache_root if cache_root is not None else get_cache_root()
    path = clip_dir(clip_id, root) / "fallback_stems.json"
    tmp_path = path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(fallback_stems), encoding="utf-8")
    tmp_path.replace(path)


def run_fallback(clip_id: str, cache_root: Path | None = None) -> FallbackStems:
    """Create and persist fallback stems for one clip."""
    fallback_stems = separate_clip(clip_id, cache_root)
    write_fallback_stems(clip_id, fallback_stems, cache_root)
    LOGGER.info("cached %d Demucs fallback stems for clip=%s", len(fallback_stems), clip_id)
    return fallback_stems


# A 30-second clip separates acceptably on CPU, avoiding a GPU reservation for this optional path.
@app.function(image=demucs_image, timeout=FALLBACK_TIMEOUT_SECONDS, gpu=None)
def fallback_clip(clip_id: str) -> FallbackStems:
    """Modal entrypoint for generating a clip's cached Demucs alternatives."""
    logging.basicConfig(level=logging.INFO)
    return run_fallback(clip_id)
