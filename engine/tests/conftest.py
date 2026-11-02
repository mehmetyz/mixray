"""Shared fixtures: a throwaway cache directory, real WAV bytes and the served-TrackMap schema."""

from __future__ import annotations

import json
import math
import struct
import wave
from io import BytesIO
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

SCHEMA_PATH = Path(__file__).resolve().parents[2] / "schema" / "trackmap.schema.json"
SAMPLE_RATE = 48_000
AMPLITUDE = 16_000


def tone_wav(frequency: float = 440.0, seconds: float = 1.0) -> bytes:
    """A real mono 16-bit WAV, so upload tests go through ffprobe and ffmpeg for real."""
    frames = int(SAMPLE_RATE * seconds)
    samples = (
        round(AMPLITUDE * math.sin(2.0 * math.pi * frequency * index / SAMPLE_RATE))
        for index in range(frames)
    )
    buffer = BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(struct.pack(f"<{frames}h", *samples))
    return buffer.getvalue()


@pytest.fixture
def cache_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the engine at an empty cache and start with no quota overrides."""
    monkeypatch.setenv("MIXRAY_CACHE_DIR", str(tmp_path))
    for name in (
        "MIXRAY_DISABLE_QUOTA",
        "MIXRAY_DAILY_CLIP_QUOTA",
        "MIXRAY_DAILY_ISOLATION_QUOTA",
    ):
        monkeypatch.delenv(name, raising=False)
    return tmp_path


@pytest.fixture(scope="session")
def trackmap_validator() -> Draft202012Validator:
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)
