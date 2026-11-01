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


# Beat-tracker starting hints, spread across the range dance and pop music is written in.
TEMPO_SEARCH_STARTS = (70.0, 85.0, 100.0, 115.0, 128.0, 140.0, 155.0, 170.0)
# Each tracker result is also offered at these multiples of its period.
METRICAL_FACTORS = (0.5, 2.0)
# Onset-peak spacing is offered as a beat, a half-beat, a two-beat and a four-beat period.
SPACING_FACTORS = (0.5, 1.0, 2.0, 4.0)
PHASE_SEARCH_STEPS = 24
# Notes that name a chord's root sit in these octaves. The root only has to break a tie between
# triads that share notes, so it adds to the harmony's match rather than deciding it.
BASS_LOWEST_NOTE = "C1"
BASS_OCTAVES = 3
BASS_BINS_PER_OCTAVE = 36
ROOT_EVIDENCE_WEIGHT = 0.25

# Harmonic change needs a previous frame to compare against.
MIN_PEAKS_FOR_SPACING = 4
# The tempo prior: music clusters here, which is what keeps a grid at a fifth of the real tempo
# from winning on alignment alone.
PRIOR_CENTRE_BPM = 125.0
PRIOR_OCTAVES = 0.9
# How close a rival tempo must be to half, equal or double to count as the same reading.
OCTAVE_TOLERANCE = 0.02

# A lead-in at least this long, counted in bars, is reported as a bar of its own.
MIN_LEAD_IN_BARS = 0.5

# Two keys whose triad votes differ by less than this are treated as tied.
TIE_EPSILON = 1e-6

# How far a beat may sit from the fitted line before the clip counts as not metronomic.
FIT_TOLERANCE_BEATS = 0.25


def _fold_into_range(bpm: float) -> float:
    """Halve or double a tempo until it lands in the range dance music is actually written in."""
    folded = bpm
    while folded < MIN_BPM and folded * 2.0 <= MAX_BPM:
        folded *= 2.0
    while folded > MAX_BPM and folded / 2.0 >= MIN_BPM:
        folded /= 2.0
    return min(max(folded, SCHEMA_MIN_BPM), SCHEMA_MAX_BPM)


class BeatGrid(TypedDict):
    """The beat positions, the tempo they imply, and how sure of it the detection is."""

    beats: list[float]
    bpm: float
    confidence: float


def _grid_alignment(
    onset_envelope: "np.ndarray", sample_rate: int, period: float, offset: float, duration: float
) -> float:
    """How strongly a uniform grid at this period lands on the clip's onsets.

    The mean onset strength under the grid, divided by the mean of the whole envelope, so a grid
    that hits accents scores above one and a grid that falls between them scores below. The tempo
    prior then pulls the answer towards the range music is written in, which is what stops a grid
    at half or a fifth of the real tempo from winning on alignment alone.
    """
    import librosa
    import numpy as np

    if period <= 0.0:
        return 0.0
    times = np.arange(offset % period, duration, period)
    if times.size == 0:
        return 0.0
    frames = np.clip(librosa.time_to_frames(times, sr=sample_rate), 0, onset_envelope.size - 1)
    envelope_mean = float(onset_envelope.mean()) or 1.0
    strength = float(onset_envelope[frames].mean()) / envelope_mean
    bpm = SECONDS_PER_MINUTE / period
    prior = float(np.exp(-0.5 * (np.log2(bpm / PRIOR_CENTRE_BPM) / PRIOR_OCTAVES) ** 2))
    return strength * prior


def _fit_period(beats: "np.ndarray") -> tuple[float, float]:
    """Fit beat time against beat index; the slope is the beat period."""
    import numpy as np

    indices = np.arange(beats.size, dtype=float)
    period, offset = (float(value) for value in np.polyfit(indices, beats, 1))
    return period, offset


def _tempo_candidates(
    onset_envelope: "np.ndarray", sample_rate: int, duration: float
) -> dict[float, tuple[float, float, float]]:
    """Propose beat grids from several independent estimators, keyed by tempo.

    No single estimator is reliable across material, measured on the evaluation set: the beat
    tracker locked onto exactly five sixteenth notes on a dense drum piece and read 113 where the
    truth was 140, while the spacing of picked onset peaks is quantised to the analysis hop and
    cannot express 140 at all. Proposing from all of them and then judging the proposals against
    the onsets gets 140 from the same audio.
    """
    import librosa
    import numpy as np

    candidates: dict[float, tuple[float, float, float]] = {}

    def offer(period: float, offset: float) -> None:
        if period <= 0.0:
            return
        bpm = SECONDS_PER_MINUTE / period
        if not MIN_BPM <= bpm <= MAX_BPM:
            return
        key = round(bpm, 2)
        if key in candidates:
            return
        score = _grid_alignment(onset_envelope, sample_rate, period, offset, duration)
        candidates[key] = (score, period, offset)

    for start_bpm in TEMPO_SEARCH_STARTS:
        frames = librosa.beat.beat_track(
            onset_envelope=onset_envelope, sr=sample_rate, units="frames", start_bpm=start_bpm
        )[1]
        beats = librosa.frames_to_time(frames, sr=sample_rate)
        if beats.size < MIN_BEATS_FOR_TEMPO:
            continue
        period, offset = _fit_period(beats)
        offer(period, offset)
        for factor in METRICAL_FACTORS:
            offer(period * factor, offset)

    # The tracker proposes nothing usable for material with no percussive onsets, so these two add
    # a tempo without beat positions; the phase is then searched on a fine grid.
    loose: list[float] = [
        float(
            np.atleast_1d(librosa.feature.tempo(onset_envelope=onset_envelope, sr=sample_rate))[0]
        )
    ]
    peaks = librosa.util.peak_pick(
        onset_envelope, pre_max=3, post_max=3, pre_avg=5, post_avg=5, delta=0.2, wait=2
    )
    if peaks.size > MIN_PEAKS_FOR_SPACING:
        gaps = np.diff(librosa.frames_to_time(peaks, sr=sample_rate))
        spacing = float(np.median(gaps))
        if spacing > 0.0:
            loose.extend(SECONDS_PER_MINUTE / (spacing * factor) for factor in SPACING_FACTORS)
    for bpm in loose:
        if not MIN_BPM <= bpm <= MAX_BPM or round(bpm, 2) in candidates:
            continue
        period = SECONDS_PER_MINUTE / bpm
        best_offset, best_score = 0.0, -1.0
        for offset in np.linspace(0.0, period, PHASE_SEARCH_STEPS, endpoint=False):
            score = _grid_alignment(onset_envelope, sample_rate, period, float(offset), duration)
            if score > best_score:
                best_offset, best_score = float(offset), score
        candidates[round(bpm, 2)] = (best_score, period, best_offset)

    return candidates


def _tempo_confidence(ranked: list[tuple[float, tuple[float, float, float]]]) -> float:
    """How clearly the winning tempo beat the alternatives.

    A rival at half or double the winner is the same reading of the music at another metrical
    level, so it is not counted as competition; a rival at an unrelated tempo is. Material whose
    only onsets are chord changes genuinely admits several tempi, and this is what says so.
    """
    if not ranked:
        return 0.0
    best_bpm, (best_score, _, _) = ranked[0]
    if best_score <= 0.0:
        return 0.0
    for bpm, (score, _, _) in ranked[1:]:
        ratio = bpm / best_bpm
        if any(abs(ratio - factor) < OCTAVE_TOLERANCE for factor in (0.5, 1.0, 2.0)):
            continue
        return round(best_score / (best_score + score), 3)
    return 1.0


def _beat_grid(onset_envelope: "np.ndarray", sample_rate: int, duration: float) -> BeatGrid:
    """Detect the tempo by proposing beat grids and judging them against the onsets.

    Two measured findings shape this. A detected beat can only land on an onset frame, so every
    gap between beats is quantised to the hop and the median gap inherits that error from a single
    gap: on a clip authored at exactly 128 BPM it read 129.20, outside our own acceptance limit.
    Fitting a line through the beat times spreads the quantisation across every beat and reads
    128.00. And no single estimator is right across material, so the tempo is chosen by evidence
    rather than by trusting one of them.
    """
    import numpy as np

    candidates = _tempo_candidates(onset_envelope, sample_rate, duration)
    if not candidates:
        return {"beats": [], "bpm": _fold_into_range(0.0), "confidence": 0.0}

    ranked = sorted(candidates.items(), key=lambda item: item[1][0], reverse=True)
    bpm, (_, period, offset) = ranked[0]
    beats = np.arange(offset % period, duration, period)
    return {
        "beats": [round(float(time), ROUND_SECONDS) for time in beats],
        "bpm": _fold_into_range(bpm),
        "confidence": _tempo_confidence(ranked),
    }


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


def _downbeat_phase(
    beats: list[float], harmonic_chroma: "np.ndarray", frame_times: "np.ndarray"
) -> int:
    """Pick which of the four beats in a bar carries the bar line.

    Assumes 4/4. Chords usually hold for a bar, so the right phase is the one whose bars each fit a
    single triad best. Accent and frame-to-frame harmonic change were tried first and got 15 of 24
    shifted versions of a clip with known bars; this got all 24, because a harmonic chroma leaves
    out the drums and most of the crowd noise that made the two evidence types disagree.
    """
    import numpy as np

    if len(beats) < BEATS_PER_BAR:
        return 0
    templates = _chord_templates()
    scores: list[float] = []
    for phase in range(BEATS_PER_BAR):
        bar_lines = beats[phase::BEATS_PER_BAR]
        fits: list[float] = []
        for start, end in itertools.pairwise(bar_lines):
            frames = (frame_times >= start) & (frame_times < end)
            if not frames.any():
                continue
            bar = harmonic_chroma[:, frames].mean(axis=1)
            energy = float(np.linalg.norm(bar))
            if energy > 0.0:
                fits.append(float((templates @ (bar / energy)).max()))
        scores.append(sum(fits) / len(fits) if fits else 0.0)
    return scores.index(max(scores))


def _match_chord(
    chroma: "np.ndarray", templates: "np.ndarray", bass_chroma: "np.ndarray"
) -> ChordMatch:
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
    bass_energy = float(bass_chroma.sum())
    if bass_energy > 0.0:
        bass_share = bass_chroma / bass_energy
        similarities = similarities + ROOT_EVIDENCE_WEIGHT * np.concatenate(
            (bass_share, bass_share)
        )
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
    """Turn bar starts into (start, end) pairs, covering the whole clip.

    The music before the first detected downbeat gets a bar of its own. The downbeat phase picks
    which of four beats carries the bar line, so a clip that begins on a downbeat still loses its
    opening bar whenever the phase is not zero, and that bar then has no chord at all. Measured on
    a clip authored with sixteen bars: the engine reported fifteen and the X-Ray screen would have
    opened on a blank. A lead-in shorter than half a bar is left alone, because that is a fragment
    of a bar rather than a bar.
    """
    if not downbeats:
        return [(0.0, duration)]
    ends = [*downbeats[1:], duration]
    bounds = [(start, end) for start, end in zip(downbeats, ends, strict=True) if end > start]
    first_start = downbeats[0]
    if len(downbeats) > 1:
        bar_length = downbeats[1] - downbeats[0]
        if first_start >= bar_length * MIN_LEAD_IN_BARS:
            bounds.insert(0, (0.0, first_start))
    return bounds


def _chords_per_bar(
    harmonic_chroma: "np.ndarray",
    bass_chroma: "np.ndarray",
    frame_times: "np.ndarray",
    bars: list[tuple[float, float]],
) -> list[ChordSpan]:
    """Name each bar's chord from its harmony, with the bass on its first beat as root evidence.

    Triads alone cannot tell Am7 from C or Cmaj7 from Em, because each pair shares three notes. The
    note under the first beat usually can. On a clip with known chords this named all of a seven
    bar progression (a half-diminished bar as its nearest triad) where the harmony alone got two,
    and was never worse on versions of the same clip with instruments removed.
    """
    templates = _chord_templates()
    chords: list[ChordSpan] = []
    for index, (start, end) in enumerate(bars):
        window = (frame_times >= start) & (frame_times < end)
        if not bool(window.any()):
            continue
        first_beat = (frame_times >= start) & (frame_times < start + (end - start) / BEATS_PER_BAR)
        root_frames = first_beat if bool(first_beat.any()) else window
        match = _match_chord(
            harmonic_chroma[:, window].mean(axis=1),
            templates,
            bass_chroma[:, root_frames].mean(axis=1),
        )
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


# Krumhansl-Kessler key profiles: how much each pitch class is heard in a major and a minor key.
# These are what separate a key from its relative, because the two share every diatonic triad but
# weight the twelve pitch classes differently.
MAJOR_PROFILE = (6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88)
MINOR_PROFILE = (6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17)


def _profile_correlation(observed: list[float], tonic: int, mode: str) -> float:
    """Pearson correlation between the pitch classes heard and a key's expected weighting."""
    import numpy as np

    profile = MINOR_PROFILE if mode == "minor" else MAJOR_PROFILE
    expected = np.roll(np.asarray(profile, dtype=float), tonic)
    heard = np.asarray(observed, dtype=float)
    if heard.std() == 0.0 or expected.std() == 0.0:
        return 0.0
    return float(np.corrcoef(heard, expected)[0, 1])


def _key_from_chords(chords: list[ChordSpan], pitch_classes: list[float]) -> KeyInfo:
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

    scored: list[tuple[float, int, str]] = []
    for tonic in range(PITCH_CLASS_COUNT):
        for mode, degrees in (("major", MAJOR_KEY_TRIADS), ("minor", MINOR_KEY_TRIADS)):
            score = sum(
                weights.get(((tonic + offset) % PITCH_CLASS_COUNT, is_minor), 0.0)
                for offset, is_minor in degrees
            )
            scored.append((score, tonic, mode))

    best_score = max(score for score, _, _ in scored)
    tied = [(tonic, mode) for score, tonic, mode in scored if score >= best_score - TIE_EPSILON]
    best_tonic, best_mode = _resolve_key_tie(tied, pitch_classes)

    return {
        "tonic": PITCH_NAMES[best_tonic],
        "mode": best_mode,
        "confidence": round(min(1.0, best_score / total), 3),
    }


def _resolve_key_tie(tied: list[tuple[int, str]], pitch_classes: list[float]) -> tuple[int, str]:
    """Choose between keys the triad vote cannot separate.

    A minor key and its relative major are built from the same seven triads, so the vote scores
    them identically and whichever the loop reached first won. That is why A minor was read as
    C major and E minor as G major: an iteration order, not a musical judgement.

    Two cheaper rules were tried against the evaluation set and both failed. Ranking by the tonic
    triad's bar time does not separate the pair at all - in Am-F-C-G both Am and C hold four bars -
    and it turned three correct minor keys into their relative majors. Preferring the key the
    progression opens on fixed two and broke a third, because the first DETECTED bar is not the
    first musical bar: the downbeat phase can drop bar one, so the rule reads the wrong chord.

    What does separate them is the pitch content itself. The relative pair shares its triads but
    not its emphasis, which is what a key profile measures.
    """
    if len(tied) == 1:
        return tied[0]
    return max(tied, key=lambda candidate: _profile_correlation(pitch_classes, *candidate))


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


def _pitch_class_weights(chroma: "np.ndarray", rms: "np.ndarray") -> list[float]:
    """How much each of the twelve pitch classes is heard, weighted by how loud the frame was.

    A quiet frame says little about the key, so weighting by level keeps a fade or a gap from
    counting as much as the loudest bar.
    """
    import numpy as np

    level = np.asarray(rms, dtype=float)
    frames = min(chroma.shape[1], level.size)
    if frames == 0:
        return [0.0] * PITCH_CLASS_COUNT
    weighted = chroma[:, :frames] * level[:frames]
    return [float(value) for value in weighted.sum(axis=1)]


def analyze_wav(wav_path: Path) -> TrackAnalysis:
    """Read one mono WAV and return every musical field a trackmap needs."""
    import librosa

    # `librosa.load` is typed as returning `int | float` for the rate because it honours whatever
    # the file carries when `sr=None`; here the rate is pinned, so it is always the integer above.
    samples, loaded_rate = librosa.load(str(wav_path), sr=ANALYSIS_SAMPLE_RATE, mono=True)
    sample_rate = int(loaded_rate)
    duration = float(librosa.get_duration(y=samples, sr=sample_rate))

    onset_envelope = librosa.onset.onset_strength(y=samples, sr=sample_rate)
    chroma = librosa.feature.chroma_cqt(y=samples, sr=sample_rate)
    frame_times = librosa.times_like(chroma, sr=sample_rate)
    rms = librosa.feature.rms(y=samples)[0][: chroma.shape[1]]
    if rms.size < chroma.shape[1]:
        chroma = chroma[:, : rms.size]
        frame_times = frame_times[: rms.size]

    grid = _beat_grid(onset_envelope, sample_rate, duration)
    beats = grid["beats"]
    harmonic = librosa.effects.harmonic(samples)
    harmonic_chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sample_rate)[:, : frame_times.size]
    bass_chroma = librosa.feature.chroma_cqt(
        y=harmonic,
        sr=sample_rate,
        fmin=librosa.note_to_hz(BASS_LOWEST_NOTE),
        n_octaves=BASS_OCTAVES,
        bins_per_octave=BASS_BINS_PER_OCTAVE,
    )[:, : frame_times.size]
    phase = _downbeat_phase(beats, harmonic_chroma, frame_times)
    downbeats = beats[phase::BEATS_PER_BAR]

    chords = _chords_per_bar(
        harmonic_chroma, bass_chroma, frame_times, _bar_bounds(downbeats, duration)
    )
    return {
        "tempo": {
            "bpm": round(grid["bpm"], 2),
            "time_signature": TIME_SIGNATURE,
            "confidence": grid["confidence"],
        },
        "beats": beats,
        "downbeats": downbeats,
        "key": _key_from_chords(chords, _pitch_class_weights(chroma, rms)),
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
