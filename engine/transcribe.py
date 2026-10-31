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
from typing import Literal, TypeAlias, TypedDict, TypeGuard

import modal
import numpy as np
from numpy.typing import NDArray

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
EASY_HIGH_MIDI = 84

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

# Basic Pitch inference parameters tuned for acoustic accuracy and note-boundary stability.
BASIC_PITCH_ONSET_THRESHOLD = 0.55
BASIC_PITCH_FRAME_THRESHOLD = 0.35

# Harmonic overtone intervals (+1 octave, +1 octave + fifth, +2 octaves) and suppression ratio.
HARMONIC_INTERVALS = frozenset({12, 19, 24})
HARMONIC_TIME_TOLERANCE_SECONDS = 0.040
HARMONIC_AMPLITUDE_RATIO = 0.55
HARMONIC_ENVELOPE_CORRELATION_MIN = 0.90

# A 50-cent half-width is narrow enough to exclude the adjacent semitone while allowing small
# tuning drift in an isolation. Frequencies inside this band are sampled on a log scale.
BAND_HALF_WIDTH_CENTS = 50.0
BAND_FREQUENCY_SAMPLES = 5
BAND_ENVELOPE_WINDOW_SECONDS = 0.040
MIN_ENVELOPE_FRAMES = 2
PCM_16_BIT_BYTES = 2

# Tukey's conventional lower fence identifies only values that are outliers relative to this clip,
# rather than treating quiet or staccato playing as noise by comparison with another recording.
LOW_OUTLIER_IQR_MULTIPLIER = 1.5

FloatArray: TypeAlias = NDArray[np.float64]

Hand = Literal["right", "left"]
RawNoteEvent: TypeAlias = tuple[float, float, int, float, list[int] | None]


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


def _midi_frequency(pitch: int) -> float:
    """Convert a MIDI note number into its equal-tempered fundamental frequency."""
    return 440.0 * math.pow(2.0, (pitch - 69) / 12.0)


def _band_energy_envelope(
    samples: FloatArray, sample_rate: int, start: float, end: float, pitch: int
) -> FloatArray:
    """Measure narrow-band energy in short consecutive windows within one note span."""
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


def _mean_band_energy(
    samples: FloatArray, sample_rate: int, start: float, end: float, pitch: int
) -> float:
    """Return the mean narrow-band energy for one candidate note."""
    envelope = _band_energy_envelope(samples, sample_rate, start, end, pitch)
    return float(envelope.mean()) if envelope.size else 0.0


def filter_residual_leakage(
    notes: list[Note], sound_wav_path: Path, rest_wav_path: Path | None = None
) -> list[Note]:
    """Drop notes whose fundamental is louder in the isolation residual than in the sound."""
    residual_path = (
        rest_wav_path if rest_wav_path is not None else sound_wav_path.parent / "rest.wav"
    )
    if not residual_path.is_file():
        return notes

    sound_samples, sound_rate = _read_mono_wav(sound_wav_path)
    rest_samples, rest_rate = _read_mono_wav(residual_path)
    kept_notes: list[Note] = []
    for note in notes:
        sound_energy = _mean_band_energy(
            sound_samples, sound_rate, note["start"], note["end"], note["pitch"]
        )
        rest_energy = _mean_band_energy(
            rest_samples, rest_rate, note["start"], note["end"], note["pitch"]
        )
        if rest_energy <= sound_energy:
            kept_notes.append(note)
    return kept_notes


def _envelopes_track(first: FloatArray, second: FloatArray) -> bool:
    """Return whether two varying band-energy envelopes share the same temporal shape."""
    if (
        first.size < MIN_ENVELOPE_FRAMES
        or second.size < MIN_ENVELOPE_FRAMES
        or first.size != second.size
    ):
        return False
    first_centered = first - first.mean()
    second_centered = second - second.mean()
    first_norm = float(np.linalg.norm(first_centered))
    second_norm = float(np.linalg.norm(second_centered))
    if first_norm == 0.0 or second_norm == 0.0:
        return False
    correlation = float(np.dot(first_centered, second_centered) / (first_norm * second_norm))
    return correlation >= HARMONIC_ENVELOPE_CORRELATION_MIN


def filter_harmonic_overtones(
    notes: list[Note],
    sound_wav_path: Path,
    time_tolerance: float = HARMONIC_TIME_TOLERANCE_SECONDS,
    amplitude_ratio: float = HARMONIC_AMPLITUDE_RATIO,
) -> list[Note]:
    """Suppress coincident high partials only when their energy envelope tracks the fundamental."""
    samples, sample_rate = _read_mono_wav(sound_wav_path)
    suppressed: set[int] = set()
    for index_h, note_h in enumerate(notes):
        for index_f, note_f in enumerate(notes):
            if index_h == index_f:
                continue
            interval = note_h["pitch"] - note_f["pitch"]
            if interval not in HARMONIC_INTERVALS:
                continue
            coincident = abs(note_h["start"] - note_f["start"]) <= time_tolerance
            weaker = note_h["velocity"] <= round(note_f["velocity"] * amplitude_ratio)
            # Both envelopes cost a narrow-band projection per frame, so they are only measured
            # once a pair has already passed the cheap interval, onset and level tests.
            if not (coincident and weaker):
                continue
            start = max(note_h["start"], note_f["start"])
            end = min(note_h["end"], note_f["end"])
            upper_envelope = _band_energy_envelope(
                samples, sample_rate, start, end, note_h["pitch"]
            )
            fundamental_envelope = _band_energy_envelope(
                samples, sample_rate, start, end, note_f["pitch"]
            )
            if _envelopes_track(upper_envelope, fundamental_envelope):
                suppressed.add(index_h)
                break
    return [note for index, note in enumerate(notes) if index not in suppressed]


def _basic_pitch_events(wav_path: Path) -> list[RawNoteEvent]:
    """Run the model only after the Modal image has loaded its heavyweight inference runtime."""
    # Basic Pitch 0.4.0 ships no type information, so this targeted suppression is required for
    # mypy's strict mode; its documented `predict` result supplies the tuple below.
    from basic_pitch.inference import predict  # type: ignore[import-not-found]

    _, _, events = predict(
        str(wav_path),
        onset_threshold=BASIC_PITCH_ONSET_THRESHOLD,
        frame_threshold=BASIC_PITCH_FRAME_THRESHOLD,
        # The clip-adaptive duration outlier rule below, not Basic Pitch's global default, decides
        # whether a very short event is noise.
        minimum_note_length=0.0,
    )
    return [
        (float(start), float(end), int(pitch), float(amplitude), pitch_bends)
        for start, end, pitch, amplitude, pitch_bends in events
    ]


def _notes_from_events(
    events: list[RawNoteEvent],
    sound_wav_path: Path,
) -> tuple[list[Note], list[float]]:
    """Convert Basic Pitch events while removing clip-relative outliers and residual leakage."""
    valid_events = [event for event in events if event[0] >= 0.0 and event[1] > event[0]]
    if not valid_events:
        return [], []

    amplitudes = np.asarray(
        [min(1.0, max(0.0, event[3])) for event in valid_events], dtype=np.float64
    )
    durations = np.asarray([event[1] - event[0] for event in valid_events], dtype=np.float64)
    amplitude_floor = _lower_outlier_floor(amplitudes)
    duration_floor = _lower_outlier_floor(durations)
    candidate_notes: list[Note] = []
    candidate_amplitudes: list[float] = []
    for start, end, pitch, amplitude, _ in valid_events:
        normalized_amplitude = min(1.0, max(0.0, amplitude))
        if normalized_amplitude < amplitude_floor or (end - start) < duration_floor:
            continue
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

    without_leakage = filter_residual_leakage(candidate_notes, sound_wav_path)
    clean_notes = filter_harmonic_overtones(without_leakage, sound_wav_path)
    surviving_note_ids = {id(note) for note in clean_notes}
    clean_amplitudes = [
        amplitude
        for note, amplitude in zip(candidate_notes, candidate_amplitudes, strict=True)
        if id(note) in surviving_note_ids
    ]
    return clean_notes, clean_amplitudes


def _lower_outlier_floor(values: FloatArray) -> float:
    """Find the clip-relative lower Tukey fence for one measured note property."""
    first_quartile, third_quartile = np.percentile(values, (25.0, 75.0))
    return max(
        0.0, float(first_quartile - LOW_OUTLIER_IQR_MULTIPLIER * (third_quartile - first_quartile))
    )


def _pitch_range(notes: list[Note]) -> PitchRange:
    """Return the observed range, with the neutral MIDI value for a silent transcription."""
    if not notes:
        return {"low": MIDI_MIN, "high": MIDI_MIN}
    pitches = [note["pitch"] for note in notes]
    return {"low": min(pitches), "high": max(pitches)}


def _mean_confidence(amplitudes: list[float]) -> float:
    """Summarise note confidence as the mean of Basic Pitch's per-note amplitudes."""
    if not amplitudes:
        return 0.0
    return round(sum(amplitudes) / len(amplitudes), ROUND_CONFIDENCE)


def _subtract_intervals(note: Note, blocked: list[tuple[float, float]]) -> list[Note]:
    """Keep only portions of a lower note that are not occupied by an already higher voice."""
    fragments = [(note["start"], note["end"])]
    for blocked_start, blocked_end in blocked:
        remaining: list[tuple[float, float]] = []
        for start, end in fragments:
            if blocked_end <= start or blocked_start >= end:
                remaining.append((start, end))
                continue
            if start < blocked_start:
                remaining.append((start, min(end, blocked_start)))
            if blocked_end < end:
                remaining.append((max(start, blocked_end), end))
        fragments = remaining
    return [
        {
            "start": start,
            "end": end,
            "pitch": note["pitch"],
            "velocity": note["velocity"],
        }
        for start, end in fragments
        if end > start
    ]


def top_voice(notes: list[Note]) -> list[Note]:
    """Remove every lower overlapping voice, preserving exposed portions of a non-chord note."""
    blocked: list[tuple[float, float]] = []
    selected: list[Note] = []
    for note in sorted(notes, key=lambda item: (-item["pitch"], item["start"], item["end"])):
        selected.extend(_subtract_intervals(note, blocked))
        blocked.append((note["start"], note["end"]))
        blocked.sort()
    return sorted(selected, key=lambda item: (item["start"], item["pitch"], item["end"]))


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
    """Snap note bounds to the analysed clip grid and discard collapsed notes."""
    grid = _eighth_grid(beats)
    if not grid:
        return []
    snapped: list[Note] = []
    for note in notes:
        start = _nearest_grid_time(note["start"], grid)
        end = _nearest_grid_time(note["end"], grid)
        if end <= start:
            continue
        snapped.append(
            {
                "start": round(start, ROUND_SECONDS),
                "end": round(end, ROUND_SECONDS),
                "pitch": note["pitch"],
                "velocity": note["velocity"],
            }
        )
    return snapped


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


def transcribe_isolated_sound(
    wav_path: Path,
    trackmap: dict[str, object],
) -> Transcription:
    """Transcribe one isolated WAV and derive its easy and intermediate keyboard arrangements."""
    if not wav_path.is_file():
        raise FileNotFoundError(f"isolated WAV not found: {wav_path}")

    beats = _time_grid(trackmap, "beats")
    downbeats = _time_grid(trackmap, "downbeats")
    chords = _chords(trackmap)
    notes, amplitudes = _notes_from_events(_basic_pitch_events(wav_path), wav_path)
    easy = transpose_easy_part(snap_to_eighths(top_voice(notes), beats), downbeats)
    left_hand = left_hand_accompaniment(chords, downbeats, easy)
    return {
        "notes": notes,
        # Mean Basic Pitch note amplitude is its per-note confidence signal, so it is a useful
        # quality measure when choosing between the SAM Audio and Demucs isolations.
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
