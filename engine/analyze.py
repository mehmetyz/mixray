"""Read the musical shape of a clip: tempo, beat grid, bars, chords, key, sections and energy.

Everything here is signal processing on the mix, with no model call and no GPU, so it runs on a
small CPU container and can be developed and verified locally. The result replaces the placeholder
tempo and chords that `ingest` writes, and it is what the piano roll and the bar ruler are drawn
from, so the beat grid has to stay internally consistent: `tempo.bpm` is derived from the detected
beats rather than reported separately, or the grid the UI draws would disagree with the number next
to it.

Run it on a cached clip with:

    uv run modal run analyze.py::analyze_clip --clip-id <id>
"""

import itertools
import json
import logging
import math
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

import modal

from images import analyze_image
from ingest import clip_dir, get_cache_root

if TYPE_CHECKING:
    import numpy as np

LOGGER = logging.getLogger(__name__)

app = modal.App("mixray-analyze")

ANALYZE_TIMEOUT_SECONDS = 300

# 22.05 kHz is librosa's own default and is plenty for beats and chroma: the highest pitch class
# this needs to resolve sits far below the Nyquist limit, and halving the rate halves the CQT cost.
ANALYSIS_SAMPLE_RATE = 22_050
BEATS_PER_BAR = 4
SECONDS_PER_MINUTE = 60.0
ENERGY_HOP_SECONDS = 0.25

# The schema caps bpm at 40..220; a beat tracker that locks onto half or double time is folded back
# into this range, which is also where dance music actually lives.
MIN_BPM = 70.0
MAX_BPM = 180.0
SCHEMA_MIN_BPM = 40.0
SCHEMA_MAX_BPM = 220.0

PITCH_CLASS_COUNT = 12
# Sharp spellings only, because `$defs/tonic` in the schema enumerates exactly these.
PITCH_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
# Middle-register root so the UI can show a chord without choosing an octave: 48 + 9 = 57 = A3.
ROOT_MIDI_BASE = 48

MAJOR_TRIAD = (0, 4, 7)
MINOR_TRIAD = (0, 3, 7)
# A bar whose chroma carries almost no energy is silence or an unpitched hit, not a chord.
MIN_CHORD_ENERGY = 1e-3
NO_CHORD_LABEL = "N"

# Scale degrees whose triads belong to a key, as (semitones above the tonic, is_minor). Natural
# minor also admits the major V, which is how minor-key pop and dance music almost always cadences.
MAJOR_KEY_TRIADS = ((0, False), (2, True), (4, True), (5, False), (7, False), (9, True))
MINOR_KEY_TRIADS = (
    (0, True),
    (3, False),
    (5, True),
    (7, True),
    (7, False),
    (8, False),
    (10, False),
)

# One section per eight seconds reads well on a 30 s clip: enough to show an arrangement, few
# enough that each chip stays wide enough to label.
SECONDS_PER_SECTION = 8.0
MIN_SECTIONS = 2
MAX_SECTIONS = 6
MIN_SECTIONS_FOR_LABELS = 3
# A two-second chip cannot be labelled legibly, and the clustering does bunch boundaries together
# on material that changes gradually, so anything shorter is folded into its neighbour.
MIN_SECTION_SECONDS = 4.0

TIME_SIGNATURE: list[int] = [BEATS_PER_BAR, 4]
# Two beats give a tempo; three give a gap spread worth trusting.
MIN_BEATS_FOR_TEMPO = 2
MIN_BEATS_FOR_CONFIDENCE = 3
ROUND_SECONDS = 3


class TempoInfo(TypedDict):
    """Tempo as the schema wants it. `bpm` always matches the spacing of `beats`."""

    bpm: float
    time_signature: list[int]
    confidence: float


class KeyInfo(TypedDict):
    """Key voted for by the detected chords."""

    tonic: str
    mode: str
    confidence: float


class ChordSpan(TypedDict):
    """One bar of harmony. `label` is `N` when the bar holds no pitched content."""

    bar: int
    start: float
    end: float
    label: str
    root_midi: int


class SectionSpan(TypedDict):
    """One arrangement section, labelled from the schema's enum."""

    start: float
    end: float
    label: str


class EnergyCurve(TypedDict):
    """Loudness over time, normalised to 0..1 against the clip's own peak."""

    hop: float
    values: list[float]


class TrackAnalysis(TypedDict):
    """Every field `analyze` contributes to a trackmap."""

    tempo: TempoInfo
    beats: list[float]
    downbeats: list[float]
    key: KeyInfo
    chords: list[ChordSpan]
    sections: list[SectionSpan]
    energy: EnergyCurve


class ChordMatch(TypedDict):
    """Best template match for one bar of chroma."""

    label: str
    root_midi: int
    pitch_class: int
    is_minor: bool
    strength: float


def _fold_into_range(bpm: float) -> float:
    """Halve or double a tempo until it lands in the range dance music is actually written in."""
    folded = bpm
    while folded < MIN_BPM and folded * 2.0 <= MAX_BPM:
        folded *= 2.0
    while folded > MAX_BPM and folded / 2.0 >= MIN_BPM:
        folded /= 2.0
    return min(max(folded, SCHEMA_MIN_BPM), SCHEMA_MAX_BPM)


def _beat_grid(onset_envelope: "np.ndarray", sample_rate: int) -> tuple[list[float], float]:
    """Detect beat times and the tempo implied by their spacing.

    The tempo is taken from the median gap between detected beats instead of from the tracker's own
    estimate, so the number shown to the user and the grid drawn under it can never disagree.
    """
    import librosa
    import numpy as np

    beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_envelope, sr=sample_rate, units="frames"
    )[1]
    beats = librosa.frames_to_time(beat_frames, sr=sample_rate)
    if beats.size < MIN_BEATS_FOR_TEMPO:
        return [], _fold_into_range(0.0)

    median_gap = float(np.median(np.diff(beats)))
    bpm = _fold_into_range(SECONDS_PER_MINUTE / median_gap) if median_gap > 0.0 else MIN_BPM
    return [round(float(time), ROUND_SECONDS) for time in beats], bpm


def _beat_confidence(beats: list[float]) -> float:
    """How evenly spaced the beats are, as 0..1.

    A steady grid has near-identical gaps, so the spread of those gaps relative to their average is
    a direct measure of how much the tracker had to guess.
    """
    import numpy as np

    if len(beats) < MIN_BEATS_FOR_CONFIDENCE:
        return 0.0
    gaps = np.diff(np.asarray(beats, dtype=float))
    mean_gap = float(gaps.mean())
    if mean_gap <= 0.0:
        return 0.0
    spread = float(gaps.std()) / mean_gap
    return round(max(0.0, min(1.0, 1.0 - spread)), 3)


def _downbeat_phase(beats: list[float], onset_envelope: "np.ndarray", sample_rate: int) -> int:
    """Pick which of the four beats in a bar carries the bar line.

    Assumes 4/4 and scores each phase by the onset strength landing on it: the first beat of a bar
    is where the kick and the chord change go, so the phase with the most accent wins.
    """
    import librosa
    import numpy as np

    if not beats:
        return 0
    frames = librosa.time_to_frames(np.asarray(beats, dtype=float), sr=sample_rate)
    frames = np.clip(frames, 0, onset_envelope.size - 1)
    strengths = onset_envelope[frames]
    scores = [float(strengths[phase::BEATS_PER_BAR].mean()) for phase in range(BEATS_PER_BAR)]
    return int(np.argmax(scores))


def _chord_templates() -> "np.ndarray":
    """The 24 major and minor triads as unit-length chroma vectors, major first."""
    import numpy as np

    templates = np.zeros((2 * PITCH_CLASS_COUNT, PITCH_CLASS_COUNT), dtype=float)
    for pitch_class in range(PITCH_CLASS_COUNT):
        for offset in MAJOR_TRIAD:
            templates[pitch_class, (pitch_class + offset) % PITCH_CLASS_COUNT] = 1.0
        for offset in MINOR_TRIAD:
            templates[
                PITCH_CLASS_COUNT + pitch_class, (pitch_class + offset) % PITCH_CLASS_COUNT
            ] = 1.0
    # Normalised in place: `np.linalg.norm` is untyped, and dividing by it would widen the result.
    templates /= np.linalg.norm(templates, axis=1, keepdims=True)
    return templates


def _match_chord(chroma: "np.ndarray", templates: "np.ndarray") -> ChordMatch:
    """Name the triad whose template points most nearly the same way as this bar's chroma."""
    import numpy as np

    energy = float(np.linalg.norm(chroma))
    if energy < MIN_CHORD_ENERGY:
        return {
            "label": NO_CHORD_LABEL,
            "root_midi": ROOT_MIDI_BASE,
            "pitch_class": 0,
            "is_minor": False,
            "strength": 0.0,
        }

    similarities = templates @ (chroma / energy)
    best = int(np.argmax(similarities))
    pitch_class = best % PITCH_CLASS_COUNT
    is_minor = best >= PITCH_CLASS_COUNT
    return {
        "label": f"{PITCH_NAMES[pitch_class]}{'m' if is_minor else ''}",
        "root_midi": ROOT_MIDI_BASE + pitch_class,
        "pitch_class": pitch_class,
        "is_minor": is_minor,
        "strength": round(float(similarities[best]), 3),
    }


def _bar_bounds(downbeats: list[float], duration: float) -> list[tuple[float, float]]:
    """Turn bar starts into (start, end) pairs, the last one running to the end of the clip."""
    if not downbeats:
        return [(0.0, duration)]
    ends = [*downbeats[1:], duration]
    return [(start, end) for start, end in zip(downbeats, ends, strict=True) if end > start]


def _chords_per_bar(
    chroma: "np.ndarray",
    frame_times: "np.ndarray",
    bars: list[tuple[float, float]],
) -> list[ChordSpan]:
    """Average the chroma inside each bar and name the chord it spells."""
    templates = _chord_templates()
    chords: list[ChordSpan] = []
    for index, (start, end) in enumerate(bars):
        window = (frame_times >= start) & (frame_times < end)
        if not bool(window.any()):
            continue
        match = _match_chord(chroma[:, window].mean(axis=1), templates)
        chords.append(
            {
                "bar": index,
                "start": round(start, ROUND_SECONDS),
                "end": round(end, ROUND_SECONDS),
                "label": match["label"],
                "root_midi": match["root_midi"],
            }
        )
    return chords


def _key_from_chords(chords: list[ChordSpan]) -> KeyInfo:
    """Vote for the key whose diatonic triads cover the most bar time.

    Deriving the key from the chords rather than from raw chroma keeps the two consistent, so the
    UI never shows a key that none of the displayed chords belongs to.
    """
    weights: dict[tuple[int, bool], float] = {}
    total = 0.0
    for chord in chords:
        if chord["label"] == NO_CHORD_LABEL:
            continue
        pitch_class = (chord["root_midi"] - ROOT_MIDI_BASE) % PITCH_CLASS_COUNT
        is_minor = chord["label"].endswith("m")
        span = max(0.0, chord["end"] - chord["start"])
        weights[pitch_class, is_minor] = weights.get((pitch_class, is_minor), 0.0) + span
        total += span

    if total <= 0.0:
        return {"tonic": PITCH_NAMES[0], "mode": "major", "confidence": 0.0}

    best_score = -1.0
    best_tonic = 0
    best_mode = "major"
    for tonic in range(PITCH_CLASS_COUNT):
        for mode, degrees in (("major", MAJOR_KEY_TRIADS), ("minor", MINOR_KEY_TRIADS)):
            score = sum(
                weights.get(((tonic + offset) % PITCH_CLASS_COUNT, is_minor), 0.0)
                for offset, is_minor in degrees
            )
            if score > best_score:
                best_score, best_tonic, best_mode = score, tonic, mode

    return {
        "tonic": PITCH_NAMES[best_tonic],
        "mode": best_mode,
        "confidence": round(min(1.0, best_score / total), 3),
    }


def _section_count(duration: float) -> int:
    return max(MIN_SECTIONS, min(MAX_SECTIONS, round(duration / SECONDS_PER_SECTION)))


def _merge_short_spans(spans: list[tuple[float, float]]) -> list[tuple[float, float]]:
    """Fold spans below the minimum length into the neighbour they border."""
    if not spans:
        return spans
    merged = [spans[0]]
    for start, end in spans[1:]:
        previous_start, previous_end = merged[-1]
        if previous_end - previous_start < MIN_SECTION_SECONDS:
            merged[-1] = (previous_start, end)
        else:
            merged.append((start, end))
    last_start, last_end = merged[-1]
    if len(merged) > 1 and last_end - last_start < MIN_SECTION_SECONDS:
        merged[-2] = (merged[-2][0], last_end)
        merged.pop()
    return merged


def _label_sections(spans: list[tuple[float, float]], loudness: list[float]) -> list[SectionSpan]:
    """Name sections by how loud they are relative to each other.

    This is an energy heuristic, not a trained structure classifier, so it only makes claims the
    energy actually supports: the quietest stretch is the breakdown and the loudest is the drop.
    Nothing here is labelled `intro` or `outro`, because a clip is a 30-second window out of a
    longer piece and where it sits in the arrangement is not something this can know. With fewer
    than three spans there is nothing to rank, so they all stay the neutral `section`.
    """
    labels = ["section"] * len(spans)
    if len(spans) >= MIN_SECTIONS_FOR_LABELS:
        quietest = min(range(len(spans)), key=lambda index: loudness[index])
        loudest = max(range(len(spans)), key=lambda index: loudness[index])
        if quietest != loudest:
            labels[quietest] = "breakdown"
            labels[loudest] = "drop"
    return [
        {"start": round(start, ROUND_SECONDS), "end": round(end, ROUND_SECONDS), "label": label}
        for (start, end), label in zip(spans, labels, strict=True)
    ]


def _sections(
    chroma: "np.ndarray", rms: "np.ndarray", frame_times: "np.ndarray", duration: float
) -> list[SectionSpan]:
    """Cut the clip where its harmony and loudness change, then label the pieces."""
    import librosa
    import numpy as np

    wanted = _section_count(duration)
    if chroma.shape[1] < wanted * 2:
        return [{"start": 0.0, "end": round(duration, ROUND_SECONDS), "label": "section"}]

    # Loudness joins chroma so a drop that keeps the same chords still reads as its own section.
    features = np.vstack([chroma, rms[np.newaxis, :] * np.ones((1, chroma.shape[1]))])
    boundaries = librosa.segment.agglomerative(features, wanted)
    starts = sorted({0.0, *(float(frame_times[index]) for index in boundaries)})
    edges = [*starts, duration]
    spans = _merge_short_spans(
        [(start, end) for start, end in itertools.pairwise(edges) if end > start]
    )

    loudness: list[float] = []
    for start, end in spans:
        window = (frame_times >= start) & (frame_times < end)
        loudness.append(float(rms[window].mean()) if bool(window.any()) else 0.0)
    return _label_sections(spans, loudness)


def _energy_curve(samples: "np.ndarray", sample_rate: int, duration: float) -> EnergyCurve:
    """Loudness resampled onto the schema's fixed hop and normalised to the clip's own peak."""
    import librosa
    import numpy as np

    buckets = max(1, math.ceil(duration / ENERGY_HOP_SECONDS))
    hop_length = max(1, int(sample_rate * ENERGY_HOP_SECONDS))
    rms = librosa.feature.rms(y=samples, frame_length=hop_length * 2, hop_length=hop_length)[0]
    if rms.size == 0:
        return {"hop": ENERGY_HOP_SECONDS, "values": [0.0] * buckets}

    indices = np.clip(np.arange(buckets), 0, rms.size - 1)
    values = rms[indices]
    peak = float(values.max())
    scaled = values / peak if peak > 0.0 else np.zeros_like(values)
    return {
        "hop": ENERGY_HOP_SECONDS,
        "values": [round(min(1.0, max(0.0, float(value))), 3) for value in scaled],
    }


def analyze_wav(wav_path: Path) -> TrackAnalysis:
    """Read one mono WAV and return every musical field a trackmap needs."""
    import librosa

    # `librosa.load` is typed as returning `int | float` for the rate because it honours whatever
    # the file carries when `sr=None`; here the rate is pinned, so it is always the integer above.
    samples, loaded_rate = librosa.load(str(wav_path), sr=ANALYSIS_SAMPLE_RATE, mono=True)
    sample_rate = int(loaded_rate)
    duration = float(librosa.get_duration(y=samples, sr=sample_rate))

    onset_envelope = librosa.onset.onset_strength(y=samples, sr=sample_rate)
    beats, bpm = _beat_grid(onset_envelope, sample_rate)
    phase = _downbeat_phase(beats, onset_envelope, sample_rate)
    downbeats = beats[phase::BEATS_PER_BAR]

    chroma = librosa.feature.chroma_cqt(y=samples, sr=sample_rate)
    frame_times = librosa.times_like(chroma, sr=sample_rate)
    rms = librosa.feature.rms(y=samples)[0][: chroma.shape[1]]
    if rms.size < chroma.shape[1]:
        chroma = chroma[:, : rms.size]
        frame_times = frame_times[: rms.size]

    chords = _chords_per_bar(chroma, frame_times, _bar_bounds(downbeats, duration))
    return {
        "tempo": {
            "bpm": round(bpm, 2),
            "time_signature": TIME_SIGNATURE,
            "confidence": _beat_confidence(beats),
        },
        "beats": beats,
        "downbeats": downbeats,
        "key": _key_from_chords(chords),
        "chords": chords,
        "sections": _sections(chroma, rms, frame_times, duration),
        "energy": _energy_curve(samples, sample_rate, duration),
    }


def apply_analysis(clip_id: str, cache_root: Path | None = None) -> TrackAnalysis:
    """Analyse a cached clip and write its producer-owned analysis sidecar."""
    root = cache_root if cache_root is not None else get_cache_root()
    wav_path = clip_dir(clip_id, root) / "mix_mono.wav"
    if not wav_path.exists():
        raise FileNotFoundError(f"no mono mix for clip {clip_id}: {wav_path}")

    analysis = analyze_wav(wav_path)
    path = clip_dir(clip_id, root) / "analysis.json"
    tmp_path = path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(analysis), encoding="utf-8")
    tmp_path.replace(path)
    LOGGER.info(
        "analyzed %s: %.1f bpm, %s %s, %d bars, %d sections",
        clip_id,
        analysis["tempo"]["bpm"],
        analysis["key"]["tonic"],
        analysis["key"]["mode"],
        len(analysis["chords"]),
        len(analysis["sections"]),
    )
    return analysis


@app.function(image=analyze_image, timeout=ANALYZE_TIMEOUT_SECONDS)
def analyze_clip(clip_id: str) -> TrackAnalysis:
    logging.basicConfig(level=logging.INFO)
    return apply_analysis(clip_id)
