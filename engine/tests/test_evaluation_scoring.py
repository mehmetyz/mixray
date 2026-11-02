"""The harness has to behave before any model is judged by it."""

from __future__ import annotations

import numpy as np
import pytest
from scoring import (
    ENGINE_DEFAULT,
    ENGINE_GUITAR,
    ENGINE_PIANO,
    Note,
    Score,
    mean_score,
    note_score,
    si_sdr,
    si_sdr_improvement,
)

import transcribe

REFERENCE: list[Note] = [(0.5, 1.0, 60.0), (1.0, 1.5, 64.0), (1.5, 2.0, 67.0)]


def _shifted(onset: float = 0.0, pitch: float = 0.0) -> list[Note]:
    return [(start + onset, end, note + pitch) for start, end, note in REFERENCE]


def test_identical_notes_score_one() -> None:
    assert note_score(REFERENCE, REFERENCE) == Score(1.0, 1.0, 1.0)


def test_an_onset_inside_50_ms_counts() -> None:
    assert note_score(REFERENCE, _shifted(onset=0.03)).f1 == 1.0


def test_an_onset_outside_50_ms_does_not() -> None:
    assert note_score(REFERENCE, _shifted(onset=0.08)).f1 == 0.0


def test_a_wrong_octave_does_not_count() -> None:
    assert note_score(REFERENCE, _shifted(pitch=12.0)).f1 == 0.0


def test_pitch_is_judged_at_50_cents_not_by_rounding() -> None:
    assert note_score(REFERENCE, _shifted(pitch=0.4)).f1 == 1.0
    assert note_score(REFERENCE, _shifted(pitch=0.6)).f1 == 0.0


def test_where_a_note_ends_does_not_matter() -> None:
    longer = [(start, end + 5.0, pitch) for start, end, pitch in REFERENCE]
    assert note_score(REFERENCE, longer).f1 == 1.0


def test_missed_notes_lower_recall_only() -> None:
    score = note_score(REFERENCE, REFERENCE[:2])
    assert score.precision == 1.0
    assert score.recall == pytest.approx(2 / 3)
    assert score.f1 == pytest.approx(0.8)


def test_invented_notes_lower_precision_only() -> None:
    score = note_score(REFERENCE, [*REFERENCE, (3.0, 3.5, 72.0)])
    assert score.precision == pytest.approx(0.75)
    assert score.recall == 1.0


def test_nothing_found_or_nothing_to_find_scores_zero() -> None:
    assert note_score(REFERENCE, []) == Score(0.0, 0.0, 0.0)
    assert note_score([], REFERENCE) == Score(0.0, 0.0, 0.0)


def test_a_zero_length_detection_is_still_scored() -> None:
    assert note_score(REFERENCE, [(start, start, pitch) for start, _, pitch in REFERENCE]).f1 == 1.0


def test_the_average_is_per_recording() -> None:
    average = mean_score([Score(1.0, 1.0, 1.0), Score(0.0, 0.0, 0.0)])
    assert average == Score(0.5, 0.5, 0.5)
    with pytest.raises(ValueError, match="no scores"):
        mean_score([])


def _signal(frequency: float) -> np.ndarray:
    return np.sin(2.0 * np.pi * frequency * np.arange(48_000) / 48_000)


def test_si_sdr_knows_a_chosen_noise_level() -> None:
    target = _signal(440.0)
    noise = _signal(1234.0) * 0.1
    assert si_sdr(target + noise, target) == pytest.approx(20.0, abs=0.01)


def test_si_sdr_ignores_scale() -> None:
    target, noise = _signal(440.0), _signal(1234.0) * 0.1
    assert si_sdr(3.0 * (target + noise), target) == pytest.approx(si_sdr(target + noise, target))


def test_si_sdr_refuses_a_silent_target() -> None:
    with pytest.raises(ValueError, match="silent"):
        si_sdr(_signal(440.0), np.zeros(48_000))


def test_improvement_is_measured_against_the_mixture() -> None:
    target, other = _signal(440.0), _signal(1234.0)
    mixture = target + other
    assert si_sdr_improvement(target + 0.1 * other, target, mixture) == pytest.approx(
        20.0, abs=0.01
    )
    assert si_sdr_improvement(mixture, target, mixture) == 0.0


def test_the_evaluation_measures_the_decoders_the_engine_ships() -> None:
    default, piano = transcribe.DEFAULT_NOTE_DECODER, transcribe.PIANO_NOTE_DECODER
    assert (ENGINE_DEFAULT.onset_threshold, ENGINE_DEFAULT.melodia_trick) == default
    assert (ENGINE_PIANO.onset_threshold, ENGINE_PIANO.melodia_trick) == piano
    assert ENGINE_DEFAULT.minimum_note_milliseconds == (
        transcribe.BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
    )
    assert ENGINE_PIANO.minimum_note_milliseconds == (
        transcribe.BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
    )
    assert ENGINE_GUITAR.minimum_note_milliseconds == (
        transcribe.GUITAR_BASIC_PITCH_MINIMUM_NOTE_LENGTH_MILLISECONDS
    )
