"""Tempo, beats and key on a synthetic track whose answers are known by construction."""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

from analyze import TrackAnalysis, analyze_wav

SAMPLE_RATE = 22_050
BPM = 120.0
SECONDS = 16.0
A_MINOR_TRIAD = (220.0, 261.63, 329.63)
CLICK_SECONDS = 0.03
PCM_MAX = 32_000


def _click_track_in_a_minor(path: Path) -> None:
    beat_samples = int(SAMPLE_RATE * 60.0 / BPM)
    click_samples = int(SAMPLE_RATE * CLICK_SECONDS)
    samples: list[int] = []
    for index in range(int(SAMPLE_RATE * SECONDS)):
        time = index / SAMPLE_RATE
        chord = sum(math.sin(2.0 * math.pi * pitch * time) for pitch in A_MINOR_TRIAD) / 6.0
        into_beat = index % beat_samples
        click = 0.5 * math.sin(2.0 * math.pi * 1500.0 * time) if into_beat < click_samples else 0.0
        samples.append(round(max(-1.0, min(1.0, chord + click)) * PCM_MAX))
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(struct.pack(f"<{len(samples)}h", *samples))


@pytest.fixture(scope="module")
def analysis(tmp_path_factory: pytest.TempPathFactory) -> TrackAnalysis:
    path = tmp_path_factory.mktemp("analysis") / "click.wav"
    _click_track_in_a_minor(path)
    return analyze_wav(path)


def test_the_tempo_of_a_click_track_is_found(analysis: TrackAnalysis) -> None:
    assert analysis["tempo"]["bpm"] == pytest.approx(BPM, abs=1.0)


def test_beats_fall_on_the_clicks(analysis: TrackAnalysis) -> None:
    gaps = [
        later - earlier
        for earlier, later in zip(analysis["beats"], analysis["beats"][1:], strict=False)
    ]
    assert gaps
    assert sum(gaps) / len(gaps) == pytest.approx(0.5, abs=0.02)


def test_bars_have_four_beats(analysis: TrackAnalysis) -> None:
    gaps = [
        later - earlier
        for earlier, later in zip(analysis["downbeats"], analysis["downbeats"][1:], strict=False)
    ]
    assert gaps
    assert sum(gaps) / len(gaps) == pytest.approx(2.0, abs=0.1)
    assert set(analysis["downbeats"]) <= set(analysis["beats"])


def test_the_key_of_a_held_minor_chord_is_found(analysis: TrackAnalysis) -> None:
    assert analysis["key"]["tonic"] == "A"
    assert analysis["key"]["mode"] == "minor"


def test_each_bar_gets_a_chord_and_the_held_chord_wins(analysis: TrackAnalysis) -> None:
    # Audio before the first bar line gets a chord span of its own.
    assert len(analysis["chords"]) >= len(analysis["downbeats"])
    assert all(chord["label"] == "Am" for chord in analysis["chords"])


def test_the_fields_match_the_trackmap_schema(
    analysis: TrackAnalysis, trackmap_validator: Draft202012Validator
) -> None:
    defs = trackmap_validator.schema["properties"]
    for field in ("tempo", "beats", "downbeats", "key", "chords", "sections", "energy"):
        errors = list(
            Draft202012Validator(
                {**defs[field], "$defs": trackmap_validator.schema["$defs"]}
            ).iter_errors(analysis[field])
        )
        assert errors == [], field
