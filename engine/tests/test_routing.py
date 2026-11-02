"""Which separator serves which prompt: the measured routing table in `fallback.py`."""

from __future__ import annotations

import pytest

from fallback import (
    SOLO_MAX_BAND_SHARE,
    SOLO_MIN_TOP_SHARE,
    StemName,
    _passes_solo_shares,
    prompt_has_notes,
    route_for_prompt,
    stem_for_prompt,
)

Energies = dict[StemName, float]


@pytest.mark.parametrize(
    ("prompt", "stem"),
    [
        ("vocals", "vocals"),
        ("Lead Singer", "vocals"),
        ("someone talking", "vocals"),
        ("kick drum", "drums"),
        ("snare", "drums"),
        ("bass guitar", "bass"),
        ("sub bass", "bass"),
        ("acoustic guitar", "guitar"),
        ("Ukulele", "guitar"),
        ("grand piano", "piano"),
        ("synth lead", "other"),
        ("electric keyboard", "other"),
        ("cello", "other"),
        ("trumpet", "other"),
    ],
)
def test_stem_for_prompt_reads_the_instrument(prompt: str, stem: StemName) -> None:
    assert stem_for_prompt(prompt) == stem


@pytest.mark.parametrize(
    "prompt", ["car horn", "a vehicle horn", "dog barking", "footsteps", "siren", ""]
)
def test_sounds_that_are_not_instruments_have_no_stem(prompt: str) -> None:
    assert stem_for_prompt(prompt) is None


@pytest.mark.parametrize("prompt", ["french horn", "horn section"])
def test_a_musical_horn_is_not_a_car_horn(prompt: str) -> None:
    assert stem_for_prompt(prompt) == "other"


@pytest.mark.parametrize("prompt", ["vocals", "electric bass", "guitar"])
def test_vocals_bass_and_guitar_go_to_sam_audio_with_ranked_draws(prompt: str) -> None:
    assert route_for_prompt(prompt) == "sam_candidates"


@pytest.mark.parametrize("prompt", ["drums", "organ", "strings", "synth pad"])
def test_stems_sam_audio_lost_on_go_to_demucs(prompt: str) -> None:
    assert route_for_prompt(prompt) == "demucs"


def test_speech_goes_to_demucs_even_though_it_reads_as_vocals() -> None:
    assert stem_for_prompt("speech") == "vocals"
    assert route_for_prompt("speech") == "demucs"


@pytest.mark.parametrize("prompt", ["car horn", "dog", "footsteps", "siren"])
def test_events_go_to_sam_audio_alone(prompt: str) -> None:
    assert route_for_prompt(prompt) == "sam_event"


@pytest.mark.parametrize("prompt", ["vocals", "bass", "guitar", "piano"])
def test_notes_are_claimed_for_measured_stems(prompt: str) -> None:
    assert prompt_has_notes(prompt)


@pytest.mark.parametrize("prompt", ["drums", "organ", "cello", "speech", "dog", "car horn"])
def test_notes_are_not_claimed_where_they_measured_badly(prompt: str) -> None:
    assert not prompt_has_notes(prompt)


def _energies(**values: float) -> Energies:
    energies: Energies = {
        "vocals": 0.0,
        "drums": 0.0,
        "bass": 0.0,
        "guitar": 0.0,
        "piano": 0.0,
        "other": 0.0,
    }
    if "piano" in values:
        energies["piano"] = values["piano"]
    if "vocals" in values:
        energies["vocals"] = values["vocals"]
    if "drums" in values:
        energies["drums"] = values["drums"]
    if "guitar" in values:
        energies["guitar"] = values["guitar"]
    return energies


def test_one_dominant_stem_is_a_solo() -> None:
    assert _passes_solo_shares(_energies(piano=0.99, guitar=0.01))


def test_a_duet_is_not_a_solo() -> None:
    assert not _passes_solo_shares(_energies(piano=0.6, guitar=0.4))


def test_a_singer_over_a_piano_is_not_a_solo() -> None:
    assert not _passes_solo_shares(_energies(piano=0.6, vocals=0.4))


def test_share_bars_are_the_measured_ones() -> None:
    assert SOLO_MAX_BAND_SHARE == 0.30
    assert SOLO_MIN_TOP_SHARE == 0.92
    assert _passes_solo_shares(_energies(piano=0.92, guitar=0.08))
    assert not _passes_solo_shares(_energies(piano=0.91, guitar=0.09))


def test_silence_is_not_a_solo() -> None:
    assert not _passes_solo_shares(_energies())
