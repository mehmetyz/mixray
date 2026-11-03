"""A separation that holds the wrong instrument still gets its notes, from the Demucs stem."""

from __future__ import annotations

import json
import wave
from pathlib import Path

import pytest

import transcribe
from fallback import DEMUCS_MODEL, FALLBACK_DIRECTORY_NAME, STEM_NAMES

SAMPLE_RATE = 22050
TRACKMAP: dict[str, object] = {"beats": [0.0, 0.5, 1.0, 1.5], "downbeats": [0.0], "chords": []}
NOTE: transcribe.RawNoteEvent = (0.0, 0.4, 64, 0.8, [])


def _silent_wav(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(b"\x00\x00" * SAMPLE_RATE)


def _clip(tmp_path: Path, prompt: str) -> Path:
    sound = tmp_path / "clip" / "isolations" / "iso" / "sound.wav"
    _silent_wav(sound)
    record = {"prompt": prompt, "method": "sam_audio_text"}
    (sound.parent / "isolation.json").write_text(json.dumps(record), encoding="utf-8")
    for stem in STEM_NAMES:
        _silent_wav(tmp_path / "clip" / FALLBACK_DIRECTORY_NAME / DEMUCS_MODEL / f"{stem}.wav")
    return sound


def _decoder_hearing_only(heard: Path, decoded: list[Path]) -> object:
    def events(path: Path, *_: object, **__: object) -> list[object]:
        decoded.append(path)
        return [NOTE] if path == heard else []

    return events


def test_notes_come_from_the_stem_when_the_separation_has_none(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sound = _clip(tmp_path, "guitar")
    stem = tmp_path / "clip" / FALLBACK_DIRECTORY_NAME / DEMUCS_MODEL / "guitar.wav"
    decoded: list[Path] = []
    monkeypatch.setattr(transcribe, "_isolation_frequency_bounds", lambda *_: None)
    monkeypatch.setattr(
        transcribe, "_isolation_basic_pitch_events", _decoder_hearing_only(stem, decoded)
    )

    result = transcribe.transcribe_isolated_sound(sound, TRACKMAP)

    assert decoded == [sound, stem]
    assert [note["pitch"] for note in result["notes"]] == [64]


def test_a_separation_with_notes_keeps_them(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    sound = _clip(tmp_path, "guitar")
    decoded: list[Path] = []
    monkeypatch.setattr(transcribe, "_isolation_frequency_bounds", lambda *_: None)
    monkeypatch.setattr(
        transcribe, "_isolation_basic_pitch_events", _decoder_hearing_only(sound, decoded)
    )

    result = transcribe.transcribe_isolated_sound(sound, TRACKMAP)

    assert decoded == [sound]
    assert len(result["notes"]) == 1
