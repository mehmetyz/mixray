"""The metrics every Mixray measurement is reported in. Pure functions, unit-tested in CI."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import NamedTuple

import mir_eval
import numpy as np
from numpy.typing import NDArray

ONSET_TOLERANCE_SECONDS = 0.05
PITCH_TOLERANCE_CENTS = 50.0
MINIMUM_INTERVAL_SECONDS = 0.01
SILENCE_FLOOR = 1e-12

# Start, end and MIDI pitch. Pitch may be fractional: GuitarSet's labels are finer than a semitone.
Note = tuple[float, float, float]
FloatArray = NDArray[np.float64]


class Score(NamedTuple):
    """Note-level scores for one recording."""

    f1: float
    precision: float
    recall: float


@dataclass(frozen=True)
class DecoderSettings:
    """What turns Basic Pitch's activations into notes. Checked against the engine in CI."""

    onset_threshold: float
    frame_threshold: float
    minimum_note_milliseconds: float
    melodia_trick: bool


# `engine/transcribe.py`: the default, what piano uses, and what guitar uses.
ENGINE_DEFAULT = DecoderSettings(0.5, 0.3, 30.0, True)
ENGINE_PIANO = DecoderSettings(0.6, 0.3, 30.0, False)
ENGINE_GUITAR = DecoderSettings(0.5, 0.3, 127.70, True)


def _intervals(notes: Sequence[Note]) -> FloatArray:
    return np.array(
        [[start, max(end, start + MINIMUM_INTERVAL_SECONDS)] for start, end, _ in notes],
        dtype=np.float64,
    ).reshape(-1, 2)


def _hertz(notes: Sequence[Note]) -> FloatArray:
    return 440.0 * 2.0 ** ((np.array([pitch for _, _, pitch in notes], dtype=np.float64) - 69) / 12)


def note_score(reference: Sequence[Note], estimate: Sequence[Note]) -> Score:
    """Onset and pitch F1 at 50 ms and 50 cents, ignoring where notes end."""
    if not reference or not estimate:
        return Score(0.0, 0.0, 0.0)
    precision, recall, f1, _ = mir_eval.transcription.precision_recall_f1_overlap(
        _intervals(reference),
        _hertz(reference),
        _intervals(estimate),
        _hertz(estimate),
        onset_tolerance=ONSET_TOLERANCE_SECONDS,
        pitch_tolerance=PITCH_TOLERANCE_CENTS,
        offset_ratio=None,
    )
    return Score(float(f1), float(precision), float(recall))


def mean_score(scores: Sequence[Score]) -> Score:
    """The average per recording, so a dense piece does not outweigh a sparse one."""
    if not scores:
        raise ValueError("no scores to average")
    return Score(
        float(np.mean([score.f1 for score in scores])),
        float(np.mean([score.precision for score in scores])),
        float(np.mean([score.recall for score in scores])),
    )


def si_sdr(estimate: FloatArray, target: FloatArray) -> float:
    """Scale-invariant signal-to-distortion ratio in dB."""
    length = min(estimate.size, target.size)
    estimate, target = estimate[:length], target[:length]
    energy = float(np.dot(target, target))
    if energy <= SILENCE_FLOOR:
        raise ValueError("the target is silent")
    projection = (float(np.dot(estimate, target)) / energy) * target
    noise = estimate - projection
    return 10.0 * math.log10(
        max(float(np.dot(projection, projection)), SILENCE_FLOOR)
        / max(float(np.dot(noise, noise)), SILENCE_FLOOR)
    )


def si_sdr_improvement(estimate: FloatArray, target: FloatArray, mixture: FloatArray) -> float:
    """How much closer to the target the estimate is than the untouched mixture, in dB."""
    return si_sdr(estimate, target) - si_sdr(mixture, target)
