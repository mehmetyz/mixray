"""Local transcription fixtures for stem attribution; no model or network is used."""

from __future__ import annotations

import json
import tempfile
import wave
from pathlib import Path

import numpy as np

import transcribe
from fallback import STEM_NAMES, StemName

SAMPLE_RATE = 8_000
DURATION_SECONDS = 0.8
PCM_SCALE = 32767.0
EXPECTED_PITCH_CONFIDENCE = 0.3
EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS = 30.0
EXPECTED_BASS_MINIMUM_NOTE_LENGTH_MILLISECONDS = 127.70
# A quantised eighth lasts 0.25 s at 120 BPM, so a sixteenth-note run is the fastest material the
# grid has to carry without losing a note.
SIXTEENTH_RUN_SECONDS = 0.125
SIXTEENTH_RUN_LENGTH = 16
BEATS_PER_SIXTEENTH_RUN = 9
QUARTER_NOTE_SECONDS = 0.5


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


def _trackmap() -> dict[str, object]:
    return {"beats": [0.0, 0.4, 0.8], "downbeats": [0.0], "chords": []}


def _low_register_fixture(directory: Path) -> None:
    """A missing stem directory must leave a low non-bass-prompted part untouched."""
    sample_count = round(SAMPLE_RATE * DURATION_SECONDS)
    low_directory = directory / "low"
    low_directory.mkdir()
    sound_path = low_directory / "sound.wav"
    _write_wav(sound_path, _tone(82.4069, 0.3, np.ones(sample_count, dtype=np.float64)))
    (low_directory / "isolation.json").write_text(
        json.dumps({"prompt": "cello", "label": "Cello", "method": "unseparated"}), encoding="utf-8"
    )
    events: list[transcribe.RawNoteEvent] = [(0.0, DURATION_SECONDS, 40, 0.3, None)]
    original_events = transcribe._basic_pitch_events

    def fixed_events(
        wav_path: Path,
        minimum_frequency: float | None = None,
        maximum_frequency: float | None = None,
        minimum_note_length: float = EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS,
        decoder: transcribe.NoteDecoder = transcribe.DEFAULT_NOTE_DECODER,
    ) -> list[transcribe.RawNoteEvent]:
        del wav_path
        assert minimum_frequency is None
        assert maximum_frequency is None
        assert minimum_note_length == EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS
        return events

    transcribe._basic_pitch_events = fixed_events
    try:
        transcription = transcribe.transcribe_isolated_sound(sound_path, _trackmap())
    finally:
        transcribe._basic_pitch_events = original_events
    assert [note["pitch"] for note in transcription["notes"]] == [40]

    # The same word out of a band mix claims no notes: other pitched stems measured only 0.13.
    (sound_path.parent / "isolation.json").write_text(
        json.dumps({"prompt": "cello", "label": "Cello", "method": "demucs"}), encoding="utf-8"
    )
    assert transcribe.transcribe_isolated_sound(sound_path, _trackmap())["notes"] == []


def _window_envelope(start: float, end: float, sample_count: int) -> np.ndarray:
    envelope = np.zeros(sample_count, dtype=np.float64)
    envelope[round(start * SAMPLE_RATE) : round(end * SAMPLE_RATE)] = 1.0
    return envelope


def _majority_stem_fixture(directory: Path) -> None:
    """The winning stem vote, rather than a piano prompt, selects the returned notes."""
    sample_count = round(SAMPLE_RATE * DURATION_SECONDS)
    clip_directory = directory / "clip"
    isolation_directory = clip_directory / "isolations" / "piano"
    isolation_directory.mkdir(parents=True)
    sound_path = isolation_directory / "sound.wav"
    _write_wav(sound_path, np.zeros(sample_count, dtype=np.float64))
    (isolation_directory / "isolation.json").write_text(
        json.dumps({"prompt": "piano chords", "label": "Piano chords"}), encoding="utf-8"
    )

    stem_directory = clip_directory / "fallback" / "htdemucs_6s"
    stem_directory.mkdir(parents=True)
    stem_samples = {stem: np.zeros(sample_count, dtype=np.float64) for stem in STEM_NAMES}
    candidate_events: list[transcribe.RawNoteEvent] = [
        (0.0, 0.2, 60, 0.2, None),
        (0.25, 0.45, 64, 0.4, None),
        (0.5, 0.7, 67, 0.8, None),
    ]
    winners: tuple[StemName, ...] = ("vocals", "vocals", "piano")
    for event, winner in zip(candidate_events, winners, strict=True):
        start, end, pitch, _, _ = event
        stem_samples[winner] += _tone(
            transcribe._midi_frequency(pitch),
            0.7,
            _window_envelope(start, end, sample_count),
        )
    for stem, samples in stem_samples.items():
        _write_wav(stem_directory / f"{stem}.wav", samples)

    original_events = transcribe._basic_pitch_events
    isolation_calls: list[tuple[float | None, float | None, float]] = []

    def fixed_events(
        wav_path: Path,
        minimum_frequency: float | None = None,
        maximum_frequency: float | None = None,
        minimum_note_length: float = EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS,
        decoder: transcribe.NoteDecoder = transcribe.DEFAULT_NOTE_DECODER,
    ) -> list[transcribe.RawNoteEvent]:
        if wav_path.name == "piano.wav":
            assert minimum_frequency is None
            assert maximum_frequency is None
            assert minimum_note_length == EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS
            return candidate_events
        isolation_calls.append((minimum_frequency, maximum_frequency, minimum_note_length))
        return candidate_events

    transcribe._basic_pitch_events = fixed_events
    try:
        transcription = transcribe.transcribe_isolated_sound(sound_path, _trackmap())
    finally:
        transcribe._basic_pitch_events = original_events

    assert isolation_calls and all(lower is not None for lower, _, _ in isolation_calls)
    assert all(upper is not None for _, upper, _ in isolation_calls)
    assert [floor for _, _, floor in isolation_calls] == [EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS]
    assert [note["pitch"] for note in transcription["notes"]] == [60, 64]
    assert transcription["pitch_confidence"] == EXPECTED_PITCH_CONFIDENCE
    assert (stem_directory / "piano.transcription.json").is_file()


def _bass_second_pass_fixture(directory: Path) -> None:
    """A bass vote reruns Basic Pitch once with its measured note-length floor."""
    sample_count = round(SAMPLE_RATE * DURATION_SECONDS)
    clip_directory = directory / "bass-clip"
    isolation_directory = clip_directory / "isolations" / "bass"
    isolation_directory.mkdir(parents=True)
    sound_path = isolation_directory / "sound.wav"
    _write_wav(sound_path, np.zeros(sample_count, dtype=np.float64))

    stem_directory = clip_directory / "fallback" / "htdemucs_6s"
    stem_directory.mkdir(parents=True)
    stem_samples = {stem: np.zeros(sample_count, dtype=np.float64) for stem in STEM_NAMES}
    candidate_events: list[transcribe.RawNoteEvent] = [
        (0.0, 0.2, 36, 0.2, None),
        (0.25, 0.45, 40, 0.4, None),
        (0.5, 0.7, 43, 0.8, None),
    ]
    winners: tuple[StemName, ...] = ("bass", "bass", "piano")
    for event, winner in zip(candidate_events, winners, strict=True):
        start, end, pitch, _, _ = event
        stem_samples[winner] += _tone(
            transcribe._midi_frequency(pitch),
            0.7,
            _window_envelope(start, end, sample_count),
        )
    for stem, samples in stem_samples.items():
        _write_wav(stem_directory / f"{stem}.wav", samples)

    original_events = transcribe._basic_pitch_events
    isolation_calls: list[float] = []

    def fixed_events(
        wav_path: Path,
        minimum_frequency: float | None = None,
        maximum_frequency: float | None = None,
        minimum_note_length: float = EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS,
        decoder: transcribe.NoteDecoder = transcribe.DEFAULT_NOTE_DECODER,
    ) -> list[transcribe.RawNoteEvent]:
        assert wav_path == sound_path
        assert minimum_frequency is None
        assert maximum_frequency is None
        isolation_calls.append(minimum_note_length)
        return candidate_events

    transcribe._basic_pitch_events = fixed_events
    try:
        transcription = transcribe.transcribe_isolated_sound(sound_path, _trackmap())
    finally:
        transcribe._basic_pitch_events = original_events

    assert isolation_calls == [
        EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS,
        EXPECTED_BASS_MINIMUM_NOTE_LENGTH_MILLISECONDS,
    ]
    assert [note["pitch"] for note in transcription["notes"]] == [36, 40]


def _routing_fixture() -> None:
    """Prompt routing and the note gate follow the instrument class, not the wording."""
    from fallback import prompt_has_notes, route_for_prompt, stem_for_prompt

    assert stem_for_prompt("lead electric guitar") == "guitar"
    assert stem_for_prompt("grand piano") == "piano"
    assert stem_for_prompt("lead vocals") == "vocals"
    # `keys` used to reach the piano stem, where a synth part scored 0.005 against 0.135.
    assert stem_for_prompt("synth keys") == "other"
    assert stem_for_prompt("organ") == "other"
    assert stem_for_prompt("cello") == "other"
    assert stem_for_prompt("supersaw lead") == "other"
    assert stem_for_prompt("a sound with no instrument in it") is None

    assert transcribe._note_decoder("grand piano") == transcribe.PIANO_NOTE_DECODER
    for other in ("lead vocals", "bass guitar", "acoustic guitar", "drums", None):
        assert transcribe._note_decoder(other) == transcribe.DEFAULT_NOTE_DECODER

    for sound, route, has_notes in (
        ("lead vocals", "sam_candidates", True),
        ("bass guitar", "sam_candidates", True),
        ("acoustic guitar", "sam_candidates", True),
        ("piano", "sam_candidates", True),
        ("drums", "demucs", False),
        ("organ", "demucs", False),
        ("person talking", "demucs", False),
        ("car honking", "sam_event", False),
        ("car horn", "sam_event", False),
        ("vehicle horn", "sam_event", False),
        ("french horn", "sam_candidates", False),
        ("brass horn", "sam_candidates", False),
    ):
        assert route_for_prompt(sound) == route, sound
        assert prompt_has_notes(sound) is has_notes, sound

    guitar = transcribe._minimum_note_length("acoustic guitar")
    assert guitar == transcribe.GUITAR_BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
    for prompt in ("lead vocals", "piano", "synthesizer", None):
        assert (
            transcribe._minimum_note_length(prompt)
            == transcribe.BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
        )


def _confidence_fixture() -> None:
    """Confidence is the plain mean of note amplitudes, with no ranker score mixed in."""
    assert transcribe._mean_confidence([0.3, 0.3]) == EXPECTED_PITCH_CONFIDENCE
    assert transcribe._mean_confidence([]) == 0.0


def _drum_prompt_bypass_fixture(directory: Path) -> None:
    """An unpitched drum prompt skips Basic Pitch and returns empty notes."""
    sample_count = round(SAMPLE_RATE * DURATION_SECONDS)
    drum_directory = directory / "drum-clip"
    drum_directory.mkdir(parents=True)
    sound_path = drum_directory / "sound.wav"
    _write_wav(sound_path, np.zeros(sample_count, dtype=np.float64))
    (drum_directory / "isolation.json").write_text(
        json.dumps({"prompt": "punchy drum kit", "label": "Drums"}), encoding="utf-8"
    )

    transcription = transcribe.transcribe_isolated_sound(sound_path, _trackmap())
    assert transcription["notes"] == []
    assert transcription["pitch_confidence"] == 0.0
    assert transcription["range"] == {"low": 0, "high": 0}
    assert transcription["arrangements"] == {"easy": [], "intermediate": []}


def _empty_vote_fixture() -> None:
    """A vote which would remove every note must preserve the unfiltered part."""
    notes = [_note(60, 100)]
    assert transcribe._notes_for_target_stem(notes, ["vocals"], "piano") == notes


def _timed_note(pitch: int, start: float, end: float) -> transcribe.Note:
    return {"start": start, "end": end, "pitch": pitch, "velocity": 80}


def _melody_preservation_fixture() -> None:
    """The arrangement stages reduce polyphony; none of them may delete a played note.

    Each case below was a measured regression: a melody filter that treated any note under a still
    ringing higher note as accompaniment left one note of five, and a grid deduplication step that
    kept the higher of two notes on one slot halved every sixteenth-note run.
    """
    descending_with_pedal = [
        _timed_note(72, 0.0, 0.9),
        _timed_note(69, 0.5, 1.4),
        _timed_note(67, 1.0, 1.9),
        _timed_note(64, 1.5, 2.4),
        _timed_note(60, 2.0, 2.9),
    ]
    assert [note["pitch"] for note in transcribe.top_voice(descending_with_pedal)] == [
        72,
        69,
        67,
        64,
        60,
    ]

    dipping_below_the_treble = [
        _timed_note(72, 0.0, 0.4),
        _timed_note(74, 0.5, 0.9),
        _timed_note(55, 1.0, 1.4),
        _timed_note(52, 1.5, 1.9),
        _timed_note(76, 2.0, 2.4),
    ]
    assert [note["pitch"] for note in transcribe.top_voice(dipping_below_the_treble)] == [
        72,
        74,
        55,
        52,
        76,
    ]

    def line(notes: list[transcribe.Note]) -> list[tuple[int, float, float]]:
        return [
            (note["pitch"], round(note["start"], 3), round(note["end"], 3))
            for note in transcribe.top_voice(notes)
        ]

    overlapping = [
        _timed_note(72, 0.0, 0.9),
        _timed_note(71, 0.5, 1.4),
        _timed_note(69, 1.0, 1.9),
    ]
    assert line(overlapping) == [(72, 0.0, 0.5), (71, 0.5, 1.0), (69, 1.0, 1.9)]
    assert overlapping == [
        _timed_note(72, 0.0, 0.9),
        _timed_note(71, 0.5, 1.4),
        _timed_note(69, 1.0, 1.9),
    ], "raw notes stay untouched for the X-Ray view"

    assert [start for _, start, _ in line(descending_with_pedal)] == [0.0, 0.5, 1.0, 1.5, 2.0]

    held_under_a_short_note = [_timed_note(72, 0.0, 2.0), _timed_note(60, 0.5, 0.9)]
    assert line(held_under_a_short_note) == [(72, 0.0, 0.5), (60, 0.5, 0.9)]

    chord = [_timed_note(60, 1.0, 2.0), _timed_note(64, 1.0, 2.0), _timed_note(67, 1.0, 2.0)]
    assert line(chord) == [(67, 1.0, 2.0)]

    chord_a_frame_apart = [_timed_note(60, 1.0, 2.0), _timed_note(67, 1.012, 2.0)]
    assert line(chord_a_frame_apart) == [(67, 1.0, 2.0)]

    repeated_pitch = [
        _timed_note(60, 0.0, 0.4),
        _timed_note(60, 0.5, 0.9),
        _timed_note(60, 1.0, 1.4),
    ]
    assert line(repeated_pitch) == [(60, 0.0, 0.4), (60, 0.5, 0.9), (60, 1.0, 1.4)]

    short_notes = [_timed_note(60, 0.0, 0.03), _timed_note(62, 0.03, 0.06)]
    assert line(short_notes) == [(60, 0.0, 0.03), (62, 0.03, 0.06)]

    assert transcribe.top_voice([]) == []

    beats = [index * QUARTER_NOTE_SECONDS for index in range(BEATS_PER_SIXTEENTH_RUN)]
    run = [
        _timed_note(
            60 + index,
            index * SIXTEENTH_RUN_SECONDS,
            index * SIXTEENTH_RUN_SECONDS + SIXTEENTH_RUN_SECONDS,
        )
        for index in range(SIXTEENTH_RUN_LENGTH)
    ]
    assert len(transcribe.snap_to_eighths(run, beats)) == SIXTEENTH_RUN_LENGTH
    placed = transcribe.snap_to_eighths(run, beats)
    assert len({note["start"] for note in placed}) == SIXTEENTH_RUN_LENGTH, "no two keys at once"

    quiet: transcribe.Note = {"start": 0.05, "end": 0.2, "pitch": 60, "velocity": 40}
    loud: transcribe.Note = {"start": 0.1, "end": 0.4, "pitch": 72, "velocity": 96}
    assert [note["pitch"] for note in transcribe.snap_to_eighths([quiet, loud], beats)] == [72]


def _downbeat_fixture() -> None:
    """The bar line sits where each bar fits one chord, wherever the clip happens to start."""
    from analyze import PITCH_CLASS_COUNT, _chord_templates, _downbeat_phase, _match_chord

    frames_per_beat = 10
    triads = ((0, 4, 7), (9, 0, 4), (5, 9, 0), (7, 11, 2))
    beats = [float(index) for index in range(28)]
    frame_times = np.arange(len(beats) * frames_per_beat) / frames_per_beat
    for true_phase in range(4):
        chroma = np.zeros((PITCH_CLASS_COUNT, frame_times.size))
        for frame, time in enumerate(frame_times):
            bar = int((time - true_phase) // 4)
            chroma[list(triads[bar % len(triads)]), frame] = 1.0
        assert _downbeat_phase(beats, chroma, frame_times) == true_phase
    assert _downbeat_phase(beats[:2], chroma, frame_times) == 0

    # Am7 holds both an A minor and a C major triad; the bass decides which is named.
    am7 = np.zeros(PITCH_CLASS_COUNT)
    am7[[9, 0, 4, 7]] = 1.0
    bass_on = np.zeros(PITCH_CLASS_COUNT)
    bass_on[9] = 1.0
    assert _match_chord(am7, _chord_templates(), bass_on)["label"] == "Am"
    bass_on = np.zeros(PITCH_CLASS_COUNT)
    bass_on[0] = 1.0
    assert _match_chord(am7, _chord_templates(), bass_on)["label"] == "C"
    assert _match_chord(am7 * 0, _chord_templates(), bass_on)["strength"] == 0.0


def main() -> None:
    assert (
        transcribe.BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
        == EXPECTED_MINIMUM_NOTE_LENGTH_MILLISECONDS
    )
    assert (
        transcribe.BASS_BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
        == EXPECTED_BASS_MINIMUM_NOTE_LENGTH_MILLISECONDS
    )
    with tempfile.TemporaryDirectory() as temporary_directory:
        directory = Path(temporary_directory)
        _low_register_fixture(directory)
        _majority_stem_fixture(directory)
        _bass_second_pass_fixture(directory)
        _drum_prompt_bypass_fixture(directory)
    _routing_fixture()
    _downbeat_fixture()
    _confidence_fixture()
    _empty_vote_fixture()
    _melody_preservation_fixture()
    print("transcribe fixtures passed")


if __name__ == "__main__":
    main()
