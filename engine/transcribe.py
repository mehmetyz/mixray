"""Turn one isolated sound into faithful notes and keyboard-ready arrangements.

Basic Pitch supplies the raw transcription for the X-Ray screen. The arrangement helpers then use
the existing full-clip beat and chord analysis rather than estimating a second tempo, so the piano
roll, on-screen keyboard, and bar score all share one grid. Run this module on a cached isolation
with:

    uv run modal run transcribe.py::transcribe_isolation --clip-id <id> --isolation-id <id>
"""

from __future__ import annotations

import json
import logging
import math
import wave
from bisect import bisect_right
from itertools import pairwise
from pathlib import Path
from typing import TYPE_CHECKING, Literal, NamedTuple, TypeAlias, TypedDict, TypeGuard

import modal

from fallback import (
    DEMUCS_MODEL,
    FALLBACK_DIRECTORY_NAME,
    STEM_NAMES,
    StemName,
    names_keyboard,
    notes_from_demucs,
    prompt_has_notes,
    stem_for_prompt,
)
from images import basic_pitch_image
from ingest import DEFAULT_CACHE_PATH, build_served_trackmap, clip_dir, get_cache_root

LOGGER = logging.getLogger(__name__)

app = modal.App("mixray-transcribe")
CACHE_VOLUME = modal.Volume.from_name("mixray-cache", create_if_missing=True)

# A capped 30-second clip transcribes comfortably on CPU; reserving a GPU would add queue time and
# cost without improving Basic Pitch's TensorFlow inference.
TRANSCRIBE_TIMEOUT_SECONDS = 300

# The schema accepts the full MIDI range, while the easy arrangement is intentionally limited to a
# comfortable keyboard melody register. Octave-only shifting keeps the tune's intervals unchanged.
MIDI_MIN = 0
MIDI_MAX = 127
EASY_LOW_MIDI = 60
# The on-screen keyboard ends at B5, and a part must never ask for a key it cannot show.
EASY_HIGH_MIDI = 83

# Basic Pitch reports amplitudes in 0..1; MIDI velocity is 1..127, and zero is invalid in the
# TrackMap contract even for a very quiet predicted note.
MIDI_VELOCITY_MAX = 127
MIDI_VELOCITY_MIN = 1

# This leaves the accompaniment quieter than the faithfully transcribed right hand while still
# being audible in the learning view.
LEFT_HAND_VELOCITY = 72
FIFTH_SEMITONES = 7

# JSON timing needs millisecond precision for the UI without preserving noisy floating-point tails.
ROUND_SECONDS = 3
ROUND_CONFIDENCE = 3
# Two consecutive detected beats are the minimum evidence needed to derive an eighth-note interval.
MIN_BEATS_FOR_EIGHTH_GRID = 2

# Basic Pitch 0.4.0 decoder defaults from basic_pitch/inference.py::predict.
BASIC_PITCH_ONSET_THRESHOLD = 0.50
BASIC_PITCH_FRAME_THRESHOLD = 0.30
# Every piano part scored best at 30 ms (average 0.963 versus 0.755 at 127.70 ms) on a curve
# measured with synthesised evaluation material; this has not been checked against real recordings.
BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS = 30.0
# Four of five bass parts scored best at Basic Pitch's 127.70 ms default on that same synthesised
# evaluation curve. Two real bass recordings since measured 0.745 at 30 ms against 0.729 here, so
# the two disagree; 0.016 over two cases is too little to move a value, and it stays.
BASS_BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS = 127.70
# Guitar is the one class measured on real recordings twice over. Across 180 held-out GuitarSet
# excerpts with published note labels, Basic Pitch's own 127.70 ms default scored 0.777 against
# 0.732 at 30 ms and brought the note count from 1.40x the truth down to 1.02x; across the eight
# real guitar mixtures it scored 0.671 against 0.634. No other class has real note labels to prove
# a gain with, so the longer gate applies to guitar alone.
GUITAR_BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS = 127.70
# Basic Pitch reads onsets on an 11.6 ms grid, so one struck chord can land a frame or two apart.
CHORD_ONSET_SECONDS = 0.025
ACCOMPANIMENT_VELOCITY_RATIO = 0.7
BASIC_PITCH_MELODIA_TRICK = True
# Measured Nov 2 on 20 public-domain piano pieces rendered with sampled grand piano, 5,221 labelled
# notes, tuned on 10 and reported once on the other 10. On Demucs piano stems, 50 ms note F1 went
# from 0.683 to 0.751 in a band and from 0.753 to 0.824 under steam, and from 0.791 to 0.885
# unseparated; the old values over-reported notes (precision 0.58). Rendered audio, not a live
# pianist, and only piano was measured, so every other sound keeps the values above.
PIANO_BASIC_PITCH_ONSET_THRESHOLD = 0.60
PIANO_BASIC_PITCH_MELODIA_TRICK = False

REGISTER_LOWER_PERCENTILE = 10.0
REGISTER_UPPER_PERCENTILE = 90.0
REGISTER_PADDING_SEMITONES = 1
STEM_TRANSCRIPTION_SUFFIX = ".transcription.json"

# Demucs' sixth stem is everything it could not assign, not an instrument, so a note vote that
# lands there is not evidence of anything.
LEFTOVER_STEM: StemName = "other"
ISOLATION_METADATA_FILENAME = "isolation.json"

# A 50-cent half-width is narrow enough to exclude the adjacent semitone while allowing small
# tuning drift in an isolation. Frequencies inside this band are sampled on a log scale.
BAND_HALF_WIDTH_CENTS = 50.0
BAND_FREQUENCY_SAMPLES = 5
BAND_ENVELOPE_WINDOW_SECONDS = 0.040
PCM_16_BIT_BYTES = 2

if TYPE_CHECKING:
    import numpy as np
    from numpy.typing import NDArray

    FloatArray: TypeAlias = NDArray[np.float64]
    StemSamples: TypeAlias = dict[StemName, tuple[FloatArray, int]]

Hand = Literal["right", "left"]
RawNoteEvent: TypeAlias = tuple[float, float, int, float, list[int] | None]
FrequencyBounds: TypeAlias = tuple[float, float]
StemWavPaths: TypeAlias = dict[StemName, Path]
StemVote: TypeAlias = tuple[list[StemName], StemName]


class Note(TypedDict):
    """A raw Basic Pitch event in the schema's Note shape."""

    start: float
    end: float
    pitch: int
    velocity: int


class ArrangedNote(Note):
    """A keyboard note with the hand and bar metadata used by the Learn screen."""

    bar: int
    hand: Hand


class PitchRange(TypedDict):
    """Lowest and highest MIDI pitches actually found in the raw transcription."""

    low: int
    high: int


class Arrangements(TypedDict):
    """The two keyboard difficulties accepted by the TrackMap schema."""

    easy: list[ArrangedNote]
    intermediate: list[ArrangedNote]


class Transcription(TypedDict):
    """Every isolation field produced by this module."""

    notes: list[Note]
    arrangements: Arrangements
    pitch_confidence: float
    range: PitchRange


class StemTranscriptionCache(TypedDict):
    """The Basic Pitch note pitches cached beside one Demucs stem."""

    pitches: list[int]


class Chord(TypedDict):
    """The chord fields needed to create one intermediate left-hand bar."""

    bar: int
    start: float
    end: float
    label: str
    root_midi: int


def _is_mapping(value: object) -> TypeGuard[dict[str, object]]:
    """Narrow JSON objects before reading their fields."""
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


def _number(value: object, name: str) -> float:
    """Read a finite JSON number without accepting booleans as integers."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"trackmap {name} must be a number")
    return float(value)


def _integer(value: object, name: str) -> int:
    """Read a JSON integer without accepting booleans."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"trackmap {name} must be an integer")
    return value


def _time_grid(trackmap: dict[str, object], field: str) -> list[float]:
    """Read the ordered beat or downbeat positions the analysis worker already produced."""
    raw_times = trackmap.get(field)
    if not isinstance(raw_times, list):
        raise ValueError(f"trackmap {field} must be an array")
    times = [_number(value, f"{field}[]") for value in raw_times]
    if any(time < 0.0 for time in times) or any(
        later <= earlier for earlier, later in pairwise(times)
    ):
        raise ValueError(f"trackmap {field} must be strictly increasing non-negative times")
    return times


def _chords(trackmap: dict[str, object]) -> list[Chord]:
    """Read the analysed bar chords, rejecting an incomplete TrackMap early."""
    raw_chords = trackmap.get("chords")
    if not isinstance(raw_chords, list):
        raise ValueError("trackmap chords must be an array")

    chords: list[Chord] = []
    for index, raw_chord in enumerate(raw_chords):
        if not _is_mapping(raw_chord):
            raise ValueError(f"trackmap chords[{index}] must be an object")
        label = raw_chord.get("label")
        if not isinstance(label, str):
            raise ValueError(f"trackmap chords[{index}].label must be a string")
        start = _number(raw_chord.get("start"), f"chords[{index}].start")
        end = _number(raw_chord.get("end"), f"chords[{index}].end")
        if start < 0.0 or end <= start:
            raise ValueError(f"trackmap chords[{index}] has invalid bounds")
        root = _integer(raw_chord.get("root_midi"), f"chords[{index}].root_midi")
        if not MIDI_MIN <= root <= MIDI_MAX:
            raise ValueError(f"trackmap chords[{index}].root_midi is outside MIDI range")
        chords.append(
            {
                "bar": _integer(raw_chord.get("bar"), f"chords[{index}].bar"),
                "start": start,
                "end": end,
                "label": label,
                "root_midi": root,
            }
        )
    return chords


def _clamp_midi(value: int) -> int:
    return min(MIDI_MAX, max(MIDI_MIN, value))


def _velocity(amplitude: float) -> int:
    """Convert Basic Pitch's per-note amplitude to the schema's integer MIDI velocity."""
    scaled = round(min(1.0, max(0.0, amplitude)) * MIDI_VELOCITY_MAX)
    return min(MIDI_VELOCITY_MAX, max(MIDI_VELOCITY_MIN, scaled))


def _read_mono_wav(wav_path: Path) -> tuple[FloatArray, int]:
    """Read Mixray's 16-bit PCM WAV as a mono floating-point signal."""
    import numpy as np

    with wave.open(str(wav_path), "rb") as wav_file:
        if wav_file.getcomptype() != "NONE":
            raise ValueError(f"WAV must use PCM encoding: {wav_path}")
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())

    if channels <= 0 or sample_rate <= 0:
        raise ValueError(f"WAV has invalid channel or sample rate metadata: {wav_path}")
    if sample_width != PCM_16_BIT_BYTES:
        raise ValueError(f"unsupported WAV sample width ({sample_width} bytes): {wav_path}")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float64) / 32768.0

    if samples.size % channels != 0:
        raise ValueError(f"WAV contains incomplete channel frames: {wav_path}")
    if channels == 1:
        return samples, sample_rate
    return samples.reshape(-1, channels).mean(axis=1), sample_rate


def _midi_frequency(pitch: float) -> float:
    """Convert a MIDI note number into its equal-tempered fundamental frequency."""
    return 440.0 * math.pow(2.0, (pitch - 69) / 12.0)


def _band_energy_envelope(
    samples: FloatArray, sample_rate: int, start: float, end: float, pitch: int
) -> FloatArray:
    """Measure narrow-band energy in short consecutive windows within one note span."""
    import numpy as np

    start_index = max(0, min(samples.size, round(start * sample_rate)))
    end_index = max(start_index, min(samples.size, round(end * sample_rate)))
    segment = samples[start_index:end_index]
    if segment.size == 0:
        return np.zeros(0, dtype=np.float64)

    frame_size = max(1, round(BAND_ENVELOPE_WINDOW_SECONDS * sample_rate))
    frame_count = max(1, int(np.ceil(segment.size / frame_size)))
    frequency = _midi_frequency(pitch)
    lower_frequency = frequency * 2.0 ** (-BAND_HALF_WIDTH_CENTS / 1200.0)
    upper_frequency = frequency * 2.0 ** (BAND_HALF_WIDTH_CENTS / 1200.0)
    frequencies = np.geomspace(lower_frequency, upper_frequency, BAND_FREQUENCY_SAMPLES)
    energies: list[float] = []
    for frame in np.array_split(segment, frame_count):
        window = np.ones(1, dtype=np.float64) if frame.size == 1 else np.hanning(frame.size)
        tapered = frame * window
        time = np.arange(frame.size, dtype=np.float64) / sample_rate
        basis = np.exp(-2j * np.pi * frequencies[:, np.newaxis] * time)
        projection = basis @ tapered
        window_energy = float(np.dot(window, window))
        energies.append(float(np.mean(np.abs(projection) ** 2) / max(window_energy, 1.0)))
    return np.asarray(energies, dtype=np.float64)


def mean_band_energy(
    samples: FloatArray, sample_rate: int, start: float, end: float, pitch: int
) -> float:
    """Return the mean narrow-band energy for one candidate note."""
    envelope = _band_energy_envelope(samples, sample_rate, start, end, pitch)
    return float(envelope.mean()) if envelope.size else 0.0


class NoteDecoder(NamedTuple):
    """The Basic Pitch decoding settings that differ by instrument."""

    onset_threshold: float
    melodia_trick: bool


DEFAULT_NOTE_DECODER = NoteDecoder(BASIC_PITCH_ONSET_THRESHOLD, BASIC_PITCH_MELODIA_TRICK)
PIANO_NOTE_DECODER = NoteDecoder(PIANO_BASIC_PITCH_ONSET_THRESHOLD, PIANO_BASIC_PITCH_MELODIA_TRICK)


def _note_decoder(prompt: str | None) -> NoteDecoder:
    """Pick the decoder measured for this instrument."""
    if prompt is not None and (stem_for_prompt(prompt) == "piano" or names_keyboard(prompt)):
        return PIANO_NOTE_DECODER
    return DEFAULT_NOTE_DECODER


def _basic_pitch_events(
    wav_path: Path,
    minimum_frequency: float | None = None,
    maximum_frequency: float | None = None,
    minimum_note_length: float = BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS,
    decoder: NoteDecoder = DEFAULT_NOTE_DECODER,
) -> list[RawNoteEvent]:
    """Run the model only after the Modal image has loaded its heavyweight inference runtime."""
    # Basic Pitch 0.4.0 ships no type information, so this targeted suppression is required for
    # mypy's strict mode; its documented `predict` result supplies the tuple below.
    from basic_pitch.inference import predict  # type: ignore[import-not-found]

    _, _, events = predict(
        str(wav_path),
        onset_threshold=decoder.onset_threshold,
        frame_threshold=BASIC_PITCH_FRAME_THRESHOLD,
        minimum_note_length=minimum_note_length,
        minimum_frequency=minimum_frequency,
        maximum_frequency=maximum_frequency,
        melodia_trick=decoder.melodia_trick,
    )
    return [
        (float(start), float(end), int(pitch), float(amplitude), pitch_bends)
        for start, end, pitch, amplitude, pitch_bends in events
    ]


def _isolation_basic_pitch_events(
    wav_path: Path,
    frequency_bounds: FrequencyBounds | None,
    minimum_note_length: float,
    decoder: NoteDecoder = DEFAULT_NOTE_DECODER,
) -> list[RawNoteEvent]:
    """Run Basic Pitch on an isolation while retaining any existing stem-derived register bounds."""
    if frequency_bounds is None:
        return _basic_pitch_events(
            wav_path, minimum_note_length=minimum_note_length, decoder=decoder
        )
    return _basic_pitch_events(
        wav_path,
        minimum_frequency=frequency_bounds[0],
        maximum_frequency=frequency_bounds[1],
        minimum_note_length=minimum_note_length,
        decoder=decoder,
    )


def _notes_from_events(
    events: list[RawNoteEvent],
) -> tuple[list[Note], list[float]]:
    """Convert valid Basic Pitch events into TrackMap notes and their amplitudes."""
    valid_events = [event for event in events if event[0] >= 0.0 and event[1] > event[0]]
    if not valid_events:
        return [], []

    candidate_notes: list[Note] = []
    candidate_amplitudes: list[float] = []
    for start, end, pitch, amplitude, _ in valid_events:
        normalized_amplitude = min(1.0, max(0.0, amplitude))
        clamped_pitch = _clamp_midi(pitch)
        candidate_notes.append(
            {
                "start": round(start, ROUND_SECONDS),
                "end": round(end, ROUND_SECONDS),
                "pitch": clamped_pitch,
                "velocity": _velocity(amplitude),
            }
        )
        candidate_amplitudes.append(normalized_amplitude)

    return candidate_notes, candidate_amplitudes


def _fallback_stem_paths(wav_path: Path) -> StemWavPaths | None:
    """Return all six cached Demucs stems, or leave the isolation transcription unchanged."""
    stem_directory = wav_path.parent.parent.parent / FALLBACK_DIRECTORY_NAME / DEMUCS_MODEL
    if not stem_directory.is_dir():
        LOGGER.info(
            "skipping stem-guided transcription; stem directory is missing: %s", stem_directory
        )
        return None

    paths = {stem: stem_directory / f"{stem}.wav" for stem in STEM_NAMES}
    missing_paths = [path for path in paths.values() if not path.is_file()]
    if missing_paths:
        LOGGER.info(
            "skipping stem-guided transcription; stem file is missing: %s", missing_paths[0]
        )
        return None
    return paths


def _isolation_metadata(wav_path: Path) -> dict[str, object] | None:
    """Read the cached isolation sidecar when it is available."""
    metadata_path = wav_path.parent / ISOLATION_METADATA_FILENAME
    if not metadata_path.is_file():
        LOGGER.info("isolation metadata is missing: %s", metadata_path)
        return None
    metadata: object = json.loads(metadata_path.read_text(encoding="utf-8"))
    if not _is_mapping(metadata):
        raise ValueError(f"isolation metadata must be an object: {metadata_path}")
    return metadata


def _isolation_prompt(metadata: dict[str, object] | None) -> str | None:
    """Return the prompt a sound was isolated with."""
    if metadata is None:
        return None
    prompt = metadata.get("prompt")
    if not isinstance(prompt, str):
        raise ValueError("isolation metadata prompt must be a string")
    return prompt


def _cached_stem_pitches(stem_wav_path: Path) -> list[int]:
    """Read or create the per-clip, per-stem Basic Pitch cache used for register bounds."""
    cache_path = stem_wav_path.with_suffix(STEM_TRANSCRIPTION_SUFFIX)
    if cache_path.is_file():
        cached: object = json.loads(cache_path.read_text(encoding="utf-8"))
        if not _is_mapping(cached):
            raise ValueError(f"stem transcription cache must be an object: {cache_path}")
        raw_pitches = cached.get("pitches")
        if not isinstance(raw_pitches, list):
            raise ValueError(f"stem transcription cache pitches must be an array: {cache_path}")
        return [
            _integer(pitch, f"stem transcription cache pitch at {cache_path}")
            for pitch in raw_pitches
        ]

    pitches = [event[2] for event in _basic_pitch_events(stem_wav_path)]
    payload: StemTranscriptionCache = {"pitches": pitches}
    cache_path.write_text(json.dumps(payload), encoding="utf-8")
    return pitches


def _stem_frequency_bounds(stem_wav_path: Path) -> FrequencyBounds | None:
    """Derive a padded 10th--90th percentile register window from one Demucs stem."""
    pitches = _cached_stem_pitches(stem_wav_path)
    if not pitches:
        LOGGER.info(
            "skipping stem register bounds; stem transcription has no notes: %s", stem_wav_path
        )
        return None

    import numpy as np

    lower_pitch, upper_pitch = np.percentile(
        np.asarray(pitches, dtype=np.float64),
        (REGISTER_LOWER_PERCENTILE, REGISTER_UPPER_PERCENTILE),
    )
    return (
        _midi_frequency(float(lower_pitch) - REGISTER_PADDING_SEMITONES),
        _midi_frequency(float(upper_pitch) + REGISTER_PADDING_SEMITONES),
    )


def _isolation_frequency_bounds(wav_path: Path, stem_paths: StemWavPaths) -> FrequencyBounds | None:
    """Map the isolation prompt to its Demucs stem before deriving decoder bounds."""
    prompt = _isolation_prompt(_isolation_metadata(wav_path))
    if prompt is None:
        return None
    stem = stem_for_prompt(prompt)
    if stem is None:
        LOGGER.info("skipping stem register bounds; prompt has no matching stem: %s", prompt)
        return None
    return _stem_frequency_bounds(stem_paths[stem])


def _stem_samples(stem_paths: StemWavPaths) -> StemSamples:
    """Load every Demucs stem once before measuring the candidate note fundamentals."""
    return {stem: _read_mono_wav(path) for stem, path in stem_paths.items()}


def _notes_for_target_stem(
    notes: list[Note], winners: list[StemName], target_stem: StemName
) -> list[Note]:
    """Keep notes won by the voted stem, retaining all notes if that would empty the part."""
    kept_notes = [
        note for note, winner in zip(notes, winners, strict=True) if winner == target_stem
    ]
    if kept_notes:
        return kept_notes
    LOGGER.info("stem vote for %s would empty the part; keeping unfiltered notes", target_stem)
    return notes


def _majority_stem_vote(notes: list[Note], stem_paths: StemWavPaths) -> StemVote | None:
    """Return each note's winning stem and the majority stem, if there are notes to vote on."""
    if not notes:
        return None

    samples_by_stem = _stem_samples(stem_paths)
    winners: list[StemName] = []
    for note in notes:
        energies = {
            stem: mean_band_energy(
                samples,
                sample_rate,
                note["start"],
                note["end"],
                note["pitch"],
            )
            for stem, (samples, sample_rate) in samples_by_stem.items()
        }
        winners.append(max(STEM_NAMES, key=energies.__getitem__))
    target_stem = max(STEM_NAMES, key=winners.count)
    return winners, target_stem


def _filter_majority_stem_notes(notes: list[Note], stem_vote: StemVote) -> list[Note]:
    """Keep notes whose fundamental is strongest in the majority-voted stem."""
    winners, target_stem = stem_vote
    if target_stem == LEFTOVER_STEM:
        # Demucs has no stem for a synth lead or a pad, so both land in its leftover bucket. The
        # vote then carries no evidence about which source a note belongs to, and filtering on it
        # measured a recall collapse on a detuned lead (0.823 to 0.508) while precision rose to
        # 1.000 - it was discarding played notes, not leakage.
        LOGGER.info("stem vote landed on %s, which is a residue rather than a source", target_stem)
        return notes
    return _notes_for_target_stem(notes, winners, target_stem)


def _pitch_range(notes: list[Note]) -> PitchRange:
    """Return the observed range, with the neutral MIDI value for a silent transcription."""
    if not notes:
        return {"low": MIDI_MIN, "high": MIDI_MIN}
    pitches = [note["pitch"] for note in notes]
    return {"low": min(pitches), "high": max(pitches)}


def _mean_confidence(amplitudes: list[float]) -> float:
    """Summarise transcription confidence as the mean amplitude of the detected notes."""
    if not amplitudes:
        return 0.0
    return round(sum(amplitudes) / len(amplitudes), ROUND_CONFIDENCE)


def top_voice(notes: list[Note]) -> list[Note]:
    """Reduce notes to one melody line without moving any onset.

    Each onset contributes its highest note, and a later onset only shortens the note before it. A
    note ringing under a later one is not restarted when that note ends: nobody played it again.
    """
    melody: list[Note] = []
    for note in sorted(notes, key=lambda item: (item["start"], -item["pitch"], item["end"])):
        previous = melody[-1] if melody else None
        if previous is None:
            melody.append(note)
        elif note["start"] - previous["start"] <= CHORD_ONSET_SECONDS:
            if note["pitch"] > previous["pitch"]:
                melody[-1] = {**note, "start": previous["start"]}
        else:
            melody[-1] = {**previous, "end": min(previous["end"], note["start"])}
            melody.append(note)
    return melody


def _eighth_grid(beats: list[float]) -> list[float]:
    """Place eighth-note slots halfway between consecutive analysed beats."""
    if len(beats) < MIN_BEATS_FOR_EIGHTH_GRID:
        return []
    eighths: list[float] = []
    for start, end in pairwise(beats):
        eighths.extend((start, (start + end) / 2.0))
    eighths.append(beats[-1])
    return eighths


def _nearest_grid_time(time: float, grid: list[float]) -> float:
    """Choose the earlier slot on an exact tie to keep snapping deterministic."""
    return min(grid, key=lambda slot: (abs(slot - time), slot))


def snap_to_eighths(notes: list[Note], beats: list[float]) -> list[Note]:
    """Place notes on the eighth grid, one note to a slot.

    Several notes can land on one slot. A clearly quieter one is accompaniment and is dropped, while
    similar loudness means a fast run: the note nearest the slot takes it and the others keep their
    own time, so a sixteenth run stays a run instead of a stack of keys to press at once.
    """
    grid = _eighth_grid(beats)
    if not grid:
        return []
    by_slot: dict[float, list[Note]] = {}
    for note in notes:
        by_slot.setdefault(_nearest_grid_time(note["start"], grid), []).append(note)

    snapped: list[Note] = []
    for slot, group in sorted(by_slot.items()):
        floor = max(note["velocity"] for note in group) * ACCOMPANIMENT_VELOCITY_RATIO
        kept = [note for note in group if note["velocity"] >= floor]
        nearest = min(kept, key=lambda note: (abs(note["start"] - slot), -note["pitch"]))
        for note in kept:
            start = slot if note is nearest else note["start"]
            end = _nearest_grid_time(note["end"], grid)
            if end <= start:
                following = bisect_right(grid, start)
                if following >= len(grid):
                    continue
                end = grid[following]
            snapped.append(
                {
                    "start": round(start, ROUND_SECONDS),
                    "end": round(end, ROUND_SECONDS),
                    "pitch": note["pitch"],
                    "velocity": note["velocity"],
                }
            )
    return sorted(snapped, key=lambda note: note["start"])


def _octave_shift(notes: list[Note]) -> int:
    """Choose an octave shift that places as much of the part in the easy register as possible."""
    if not notes:
        return 0

    shifts = range(-120, 121, 12)

    def score(shift: int) -> tuple[int, int, int]:
        pitches = [note["pitch"] + shift for note in notes]
        outside = sum(pitch < EASY_LOW_MIDI or pitch > EASY_HIGH_MIDI for pitch in pitches)
        distance = sum(
            max(EASY_LOW_MIDI - pitch, 0) + max(pitch - EASY_HIGH_MIDI, 0) for pitch in pitches
        )
        return outside, distance, abs(shift)

    valid_shifts = [
        shift
        for shift in shifts
        if all(MIDI_MIN <= note["pitch"] + shift <= MIDI_MAX for note in notes)
    ]
    return min(valid_shifts, key=score)


def _bar_index(start: float, downbeats: list[float]) -> int:
    """Return the zero-based bar whose start contains this note's onset."""
    return max(0, bisect_right(downbeats, start) - 1)


def _fold_into_easy_register(pitch: int) -> int:
    """Move one pitch by whole octaves until it sits in the easy register.

    A single shift of the whole part cannot always succeed: measured on a transcribed piano stem,
    the raw notes spanned 45 semitones while the easy window is 24, so seven of forty-five notes
    stayed outside it and the keyboard, which draws C4-B5, had nothing to show them on. Folding the
    stragglers individually keeps every note playable and preserves its pitch class, which is what
    matters when learning the part on keys; the cost is that an extreme leap is compressed into the
    same two octaves as the rest.
    """
    folded = pitch
    while folded < EASY_LOW_MIDI:
        folded += 12
    while folded > EASY_HIGH_MIDI:
        folded -= 12
    return _clamp_midi(folded)


def transpose_easy_part(notes: list[Note], downbeats: list[float]) -> list[ArrangedNote]:
    """Shift the part by octaves into the easy register, folding any note the shift cannot reach."""
    shift = _octave_shift(notes)
    return [
        {
            "start": note["start"],
            "end": note["end"],
            "pitch": _fold_into_easy_register(note["pitch"] + shift),
            "velocity": note["velocity"],
            "bar": _bar_index(note["start"], downbeats),
            "hand": "right",
        }
        for note in notes
    ]


def _left_root(root_midi: int, right_hand_low: int) -> int:
    """Lower a chord root by octaves until its fifth clears the right-hand melody range."""
    root = root_midi
    while root + FIFTH_SEMITONES >= right_hand_low and root - 12 >= MIDI_MIN:
        root -= 12
    return root


def left_hand_accompaniment(
    chords: list[Chord], downbeats: list[float], right_hand: list[ArrangedNote]
) -> list[ArrangedNote]:
    """Hold each analysed chord's root and fifth below the easy arrangement for one bar."""
    right_hand_low = min((note["pitch"] for note in right_hand), default=EASY_LOW_MIDI)
    accompaniment: list[ArrangedNote] = []
    for chord in chords:
        if chord["label"] == "N":
            continue
        root = _left_root(chord["root_midi"], right_hand_low)
        fifth = root + FIFTH_SEMITONES
        if root < MIDI_MIN or fifth > MIDI_MAX:
            continue
        bar = _bar_index(chord["start"], downbeats)
        for pitch in (root, fifth):
            accompaniment.append(
                {
                    "start": round(chord["start"], ROUND_SECONDS),
                    "end": round(chord["end"], ROUND_SECONDS),
                    "pitch": pitch,
                    "velocity": LEFT_HAND_VELOCITY,
                    "bar": bar,
                    "hand": "left",
                }
            )
    return accompaniment


def _intermediate(
    right_hand: list[ArrangedNote], left_hand: list[ArrangedNote]
) -> list[ArrangedNote]:
    """Keep the right hand intact and order simultaneous left-hand notes first for stable JSON."""
    return sorted(
        [*right_hand, *left_hand],
        key=lambda note: (note["start"], note["hand"] != "left", note["pitch"], note["end"]),
    )


def _minimum_note_length(prompt: str | None) -> float:
    """Pick the shortest note the decoder may keep, by the instrument class the prompt names."""
    if prompt is not None and stem_for_prompt(prompt) == "guitar":
        return GUITAR_BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
    return BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS


def transcribe_isolated_sound(
    wav_path: Path,
    trackmap: dict[str, object],
) -> Transcription:
    """Transcribe one isolated WAV and derive its easy and intermediate keyboard arrangements."""
    if not wav_path.is_file():
        raise FileNotFoundError(f"isolated WAV not found: {wav_path}")

    metadata = _isolation_metadata(wav_path)
    prompt = _isolation_prompt(metadata)
    unseparated = metadata is not None and metadata.get("method") == "unseparated"
    # A solo recording is the instrument itself, so its notes hold whatever the prompt called it.
    if prompt is not None and not unseparated and not prompt_has_notes(prompt):
        LOGGER.info("no notes claimed for this sound: %s", prompt)
        return {
            "notes": [],
            "pitch_confidence": 0.0,
            "range": {"low": MIDI_MIN, "high": MIDI_MIN},
            "arrangements": {"easy": [], "intermediate": []},
        }

    beats = _time_grid(trackmap, "beats")
    downbeats = _time_grid(trackmap, "downbeats")
    chords = _chords(trackmap)
    stem_paths = None if unseparated else _fallback_stem_paths(wav_path)
    frequency_bounds = (
        _isolation_frequency_bounds(wav_path, stem_paths) if stem_paths is not None else None
    )
    minimum_note_length = _minimum_note_length(prompt)
    note_source = wav_path
    separated_by_sam = metadata is not None and metadata.get("method") == "sam_audio_text"
    if (
        stem_paths is not None
        and prompt is not None
        and separated_by_sam
        and notes_from_demucs(prompt)
    ):
        stem = stem_for_prompt(prompt)
        if stem is not None:
            # The isolation keeps SAM Audio's cleaner sound; the notes come from the stem that
            # measured better on real piano labels.
            note_source = stem_paths[stem]
    decoder = _note_decoder(prompt)
    events = _isolation_basic_pitch_events(
        note_source, frequency_bounds, minimum_note_length, decoder
    )
    notes, amplitudes = _notes_from_events(events)
    stem = stem_for_prompt(prompt) if prompt is not None else None
    if (
        not notes
        and stem_paths is not None
        and stem is not None
        and note_source != stem_paths[stem]
    ):
        # A separation can come back holding the wrong instrument. On a band clip SAM Audio's
        # "guitar" held the horns and gave no notes at all, while the Demucs guitar stem was clean.
        LOGGER.info("no notes in the separated %s; reading them from its Demucs stem", prompt)
        note_source = stem_paths[stem]
        events = _isolation_basic_pitch_events(
            note_source, frequency_bounds, minimum_note_length, decoder
        )
        notes, amplitudes = _notes_from_events(events)
    if stem_paths is not None:
        stem_vote = _majority_stem_vote(notes, stem_paths)
        if (
            stem_vote is not None
            and stem_vote[1] == "bass"
            and minimum_note_length != BASS_BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
        ):
            LOGGER.info("rerunning Basic Pitch with bass floor because stem vote selected bass")
            events = _isolation_basic_pitch_events(
                note_source,
                frequency_bounds,
                BASS_BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS,
                decoder,
            )
            notes, amplitudes = _notes_from_events(events)
            stem_vote = _majority_stem_vote(notes, stem_paths)
        if stem_vote is None:
            filtered_notes = notes
        else:
            filtered_notes = _filter_majority_stem_notes(notes, stem_vote)
        surviving_note_ids = {id(note) for note in filtered_notes}
        amplitudes = [
            amplitude
            for note, amplitude in zip(notes, amplitudes, strict=True)
            if id(note) in surviving_note_ids
        ]
        notes = filtered_notes
    easy = transpose_easy_part(snap_to_eighths(top_voice(notes), beats), downbeats)
    left_hand = left_hand_accompaniment(chords, downbeats, easy)
    return {
        "notes": notes,
        "pitch_confidence": _mean_confidence(amplitudes),
        "range": _pitch_range(notes),
        "arrangements": {"easy": easy, "intermediate": _intermediate(easy, left_hand)},
    }


class CleanerVersionChoice(TypedDict):
    """The outcome of comparing transcription confidence between two separation candidates."""

    preferred: Literal["sam_audio", "demucs"]
    confidence_difference: float
    sam_confidence: float
    demucs_confidence: float


def compare_pitch_confidence(
    sam_confidence: float, demucs_confidence: float
) -> CleanerVersionChoice:
    """Choose the cleaner version for transcription based on Basic Pitch confidence.

    When Demucs yields higher mean pitch confidence, it is chosen as the preferred version
    while still leaving both candidates selectable in the UI.
    """
    diff = round(abs(demucs_confidence - sam_confidence), ROUND_CONFIDENCE)
    preferred: Literal["sam_audio", "demucs"] = (
        "demucs" if demucs_confidence > sam_confidence else "sam_audio"
    )
    return {
        "preferred": preferred,
        "confidence_difference": diff,
        "sam_confidence": round(sam_confidence, ROUND_CONFIDENCE),
        "demucs_confidence": round(demucs_confidence, ROUND_CONFIDENCE),
    }


def apply_transcription(
    clip_id: str, isolation_id: str, cache_root: Path | None = None
) -> Transcription:
    """Read one cached isolation and write its producer-owned transcription sidecar."""
    root = cache_root if cache_root is not None else get_cache_root()
    wav_path = clip_dir(clip_id, root) / "isolations" / isolation_id / "sound.wav"
    transcription = transcribe_isolated_sound(wav_path, build_served_trackmap(clip_id, root))
    path = wav_path.parent / "transcription.json"
    tmp_path = path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(transcription), encoding="utf-8")
    tmp_path.replace(path)
    LOGGER.info(
        "transcribed isolation=%s for clip=%s: %d notes, confidence=%.3f",
        isolation_id,
        clip_id,
        len(transcription["notes"]),
        transcription["pitch_confidence"],
    )
    return transcription


@app.function(
    image=basic_pitch_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    timeout=TRANSCRIBE_TIMEOUT_SECONDS,
    gpu=None,
)
def transcribe_isolation(clip_id: str, isolation_id: str) -> Transcription:
    """Modal CPU entrypoint for one cached isolated sound."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        return apply_transcription(clip_id, isolation_id)
    finally:
        CACHE_VOLUME.commit()
