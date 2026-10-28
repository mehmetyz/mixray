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
from bisect import bisect_right
from itertools import pairwise
from pathlib import Path
from typing import Literal, TypeAlias, TypedDict, TypeGuard

import modal

from images import basic_pitch_image
from ingest import DEFAULT_CACHE_PATH, clip_dir, get_cache_root, trackmap_path, write_trackmap

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


def _basic_pitch_events(wav_path: Path) -> list[RawNoteEvent]:
    """Run the model only after the Modal image has loaded its heavyweight inference runtime."""
    # Basic Pitch 0.4.0 ships no type information, so this targeted suppression is required for
    # mypy's strict mode; its documented `predict` result supplies the tuple below.
    from basic_pitch.inference import predict  # type: ignore[import-not-found]

    _, _, events = predict(str(wav_path))
    return [
        (float(start), float(end), int(pitch), float(amplitude), pitch_bends)
        for start, end, pitch, amplitude, pitch_bends in events
    ]


def _notes_from_events(events: list[RawNoteEvent]) -> tuple[list[Note], list[float]]:
    """Convert Basic Pitch events faithfully while retaining amplitudes for confidence scoring."""
    notes: list[Note] = []
    amplitudes: list[float] = []
    for start, end, pitch, amplitude, _ in events:
        if start < 0.0 or end <= start:
            continue
        notes.append(
            {
                "start": round(start, ROUND_SECONDS),
                "end": round(end, ROUND_SECONDS),
                "pitch": _clamp_midi(pitch),
                "velocity": _velocity(amplitude),
            }
        )
        amplitudes.append(min(1.0, max(0.0, amplitude)))
    return notes, amplitudes


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


def transcribe_isolated_sound(wav_path: Path, trackmap: dict[str, object]) -> Transcription:
    """Transcribe one isolated WAV and derive its easy and intermediate keyboard arrangements."""
    if not wav_path.is_file():
        raise FileNotFoundError(f"isolated WAV not found: {wav_path}")

    beats = _time_grid(trackmap, "beats")
    downbeats = _time_grid(trackmap, "downbeats")
    chords = _chords(trackmap)
    notes, amplitudes = _notes_from_events(_basic_pitch_events(wav_path))
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


def write_transcription_to_trackmap(
    clip_id: str,
    isolation_id: str,
    transcription: Transcription,
    cache_root: Path | None = None,
) -> None:
    """Update one isolation's fields without disturbing concurrent clip analysis data."""
    root = cache_root if cache_root is not None else get_cache_root()
    path = trackmap_path(clip_id, root)
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not _is_mapping(loaded):
        raise ValueError(f"invalid trackmap for clip {clip_id}")
    isolations = loaded.get("isolations")
    if not isinstance(isolations, list):
        raise ValueError(f"invalid isolations for clip {clip_id}")

    for isolation in isolations:
        if not _is_mapping(isolation) or isolation.get("id") != isolation_id:
            continue
        isolation["notes"] = transcription["notes"]
        isolation["arrangements"] = transcription["arrangements"]
        isolation["pitch_confidence"] = transcription["pitch_confidence"]
        isolation["range"] = transcription["range"]
        write_trackmap(clip_id, loaded, root)
        return
    raise KeyError(f"isolation {isolation_id} not found for clip {clip_id}")


def apply_transcription(
    clip_id: str, isolation_id: str, cache_root: Path | None = None
) -> Transcription:
    """Read one cached isolation, transcribe it, and persist only its own TrackMap fields."""
    root = cache_root if cache_root is not None else get_cache_root()
    path = trackmap_path(clip_id, root)
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not _is_mapping(loaded):
        raise ValueError(f"invalid trackmap for clip {clip_id}")
    wav_path = clip_dir(clip_id, root) / "isolations" / isolation_id / "sound.wav"
    transcription = transcribe_isolated_sound(wav_path, loaded)
    write_transcription_to_trackmap(clip_id, isolation_id, transcription, root)
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
