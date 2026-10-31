"""Local signal fixtures for transcription filters; no model or network is used."""

from __future__ import annotations

import json
import tempfile
import wave
from pathlib import Path

import numpy as np

import transcribe

SAMPLE_RATE = 8_000
DURATION_SECONDS = 0.8
PCM_SCALE = 32767.0


def _tone(frequency: float, amplitude: float, envelope: np.ndarray) -> np.ndarray:
    time = np.arange(envelope.size, dtype=np.float64) / SAMPLE_RATE
    return amplitude * envelope * np.sin(2.0 * np.pi * frequency * time)


def _write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = np.clip(samples, -1.0, 1.0)
    encoded = np.round(pcm * PCM_SCALE).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(encoded)


def _note(pitch: int, velocity: int) -> transcribe.Note:
    return {"start": 0.0, "end": DURATION_SECONDS, "pitch": pitch, "velocity": velocity}


def _leakage_fixture(directory: Path) -> None:
    sample_count = round(SAMPLE_RATE * DURATION_SECONDS)
    envelope = np.ones(sample_count, dtype=np.float64)
    loud = _tone(110.0, 0.7, envelope)
    quiet = _tone(110.0, 0.08, envelope)
    sound_path = directory / "sound.wav"
    rest_path = directory / "rest.wav"
    note = _note(45, 100)

    _write_wav(sound_path, loud)
    _write_wav(rest_path, quiet)
    assert transcribe.filter_residual_leakage([note], sound_path, rest_path) == [note]

    _write_wav(sound_path, quiet)
    _write_wav(rest_path, loud)
    assert transcribe.filter_residual_leakage([note], sound_path, rest_path) == []


def _overtone_fixture(directory: Path) -> None:
    sample_count = round(SAMPLE_RATE * DURATION_SECONDS)
    time = np.arange(sample_count, dtype=np.float64) / SAMPLE_RATE
    c3_envelope = 0.3 + 0.7 * np.sin(2.0 * np.pi * 2.0 * time) ** 2
    c4_envelope = 0.3 + 0.7 * np.cos(2.0 * np.pi * 2.0 * time) ** 2
    g3_envelope = 0.3 + 0.7 * np.sin(2.0 * np.pi * 1.5 * time) ** 2
    d5_envelope = 0.3 + 0.7 * np.cos(2.0 * np.pi * 1.5 * time) ** 2
    voicing = (
        _tone(130.8128, 0.7, c3_envelope)
        + _tone(261.6256, 0.2, c4_envelope)
        + _tone(195.9977, 0.65, g3_envelope)
        + _tone(587.3295, 0.2, d5_envelope)
    )
    sound_path = directory / "voicing.wav"
    notes = [_note(48, 120), _note(60, 40), _note(55, 110), _note(74, 40)]

    _write_wav(sound_path, voicing)
    assert transcribe.filter_harmonic_overtones(notes, sound_path) == notes


def _low_register_fixture(directory: Path) -> None:
    sample_count = round(SAMPLE_RATE * DURATION_SECONDS)
    low_directory = directory / "low"
    low_directory.mkdir()
    sound_path = low_directory / "sound.wav"
    _write_wav(sound_path, _tone(82.4069, 0.3, np.ones(sample_count, dtype=np.float64)))
    (low_directory / "isolation.json").write_text(
        json.dumps({"prompt": "cello", "label": "Cello"}), encoding="utf-8"
    )
    events: list[transcribe.RawNoteEvent] = [(0.0, DURATION_SECONDS, 40, 0.3, None)]
    original_events = transcribe._basic_pitch_events
    event_loader_name = "_basic_pitch_events"

    def fixed_events(_: Path) -> list[transcribe.RawNoteEvent]:
        return events

    setattr(transcribe, event_loader_name, fixed_events)
    try:
        transcription = transcribe.transcribe_isolated_sound(
            sound_path,
            {"beats": [0.0, 0.4, 0.8], "downbeats": [0.0], "chords": []},
        )
    finally:
        setattr(transcribe, event_loader_name, original_events)
    assert [note["pitch"] for note in transcription["notes"]] == [40]


def _amplitude_gate_fixture() -> None:
    quiet_cluster = np.asarray([0.04, 0.05, 0.05, 0.06], dtype=np.float64)
    loud_cluster = np.asarray([0.79, 0.80, 0.80, 0.81], dtype=np.float64)
    threshold = transcribe._otsu_amplitude_floor(np.concatenate((quiet_cluster, loud_cluster)))
    assert threshold is not None
    assert float(quiet_cluster.max()) < threshold < float(loud_cluster.min())

    amplitudes = np.asarray([0.48, 0.49, 0.50, 0.51, 0.52], dtype=np.float64)
    threshold = transcribe._otsu_amplitude_floor(amplitudes)
    events: list[transcribe.RawNoteEvent] = [
        (0.0, DURATION_SECONDS, 60 + index, float(amplitude), None)
        for index, amplitude in enumerate(amplitudes)
    ]
    surviving_events = [event for event in events if threshold is None or event[3] >= threshold]
    assert threshold is None
    assert surviving_events == events


def main() -> None:
    with tempfile.TemporaryDirectory() as temporary_directory:
        directory = Path(temporary_directory)
        _leakage_fixture(directory)
        _overtone_fixture(directory)
        _low_register_fixture(directory)
        _amplitude_gate_fixture()
    print("transcribe fixtures passed")


if __name__ == "__main__":
    main()
