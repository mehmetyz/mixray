"""Nothing a model says reaches a TrackMap unchecked: chips, labels, recipes and summaries."""

from __future__ import annotations

import json

import pytest

from label import LABEL_FIXTURES, check_label_fixtures, parse_label
from recipe import parse_recipe
from suggest import (
    MAX_SUGGESTIONS,
    SoundSummaryFacts,
    heard_audio,
    midi_note_name,
    parse_suggestions,
    summary_numbers_are_allowed,
)


def _chips(*pairs: tuple[str, str]) -> str:
    return json.dumps(
        {
            "summary": "  A song. ",
            "suggestions": [{"label": label, "prompt": prompt} for label, prompt in pairs],
        }
    )


def test_chips_are_cleaned() -> None:
    parsed = parse_suggestions(_chips((" Piano ", " Grand Piano. ")))
    assert parsed == {
        "summary": "A song.",
        "suggestions": [{"label": "Piano", "prompt": "grand piano"}],
    }


def test_one_instrument_under_many_names_becomes_one_chip() -> None:
    parsed = parse_suggestions(
        _chips(
            ("Solo piano", "solo piano"),
            ("Upright piano", "upright piano"),
            ("Acoustic piano", "acoustic piano"),
            ("Guitar", "guitar"),
        )
    )
    assert [chip["label"] for chip in parsed["suggestions"]] == ["Solo piano", "Guitar"]


def test_sounds_with_no_standard_stem_are_kept_apart() -> None:
    parsed = parse_suggestions(
        _chips(("Dog", "dog barking"), ("Siren", "siren"), ("Dog", "dog barking"))
    )
    assert [chip["prompt"] for chip in parsed["suggestions"]] == ["dog barking", "siren"]


def test_one_chip_is_enough() -> None:
    assert len(parse_suggestions(_chips(("Piano", "piano")))["suggestions"]) == 1


def test_too_many_chips_are_cut() -> None:
    pairs = [(f"Sound {name}", f"sound {name}") for name in "abcdefghij"]
    assert len(parse_suggestions(_chips(*pairs))["suggestions"]) == MAX_SUGGESTIONS


@pytest.mark.parametrize(
    "raw",
    [
        "[]",
        "{}",
        '{"summary": "s"}',
        '{"summary": 3, "suggestions": []}',
        '{"summary": "s", "suggestions": []}',
        '{"summary": "s", "suggestions": [{"label": "", "prompt": "x"}]}',
        '{"summary": "s", "suggestions": ["piano"]}',
    ],
)
def test_replies_without_a_usable_chip_are_errors_not_placeholders(raw: str) -> None:
    with pytest.raises(RuntimeError):
        parse_suggestions(raw)


@pytest.mark.parametrize(
    "reply",
    [
        "I can only see a waveform image.",
        "I cannot hear anything in this clip.",
        "There is no audio here.",
        "This is a BLACK SCREEN.",
    ],
)
def test_a_refusal_to_listen_is_recognised(reply: str) -> None:
    assert not heard_audio(reply)


def test_a_description_of_sound_counts_as_heard() -> None:
    assert heard_audio("A soft piano with a steam hiss behind it.")


def test_recorded_label_replies_still_parse() -> None:
    check_label_fixtures()
    assert len(LABEL_FIXTURES) > 0


@pytest.mark.parametrize(
    ("raw", "label", "prompt"),
    [
        ('{"label": "Piano", "prompt": "piano"}', "Piano", "piano"),
        ('{"label": "x", "prompt": "midi keyboard"}', "MIDI Keyboard", "midi keyboard"),
        ('{"label": "Dj Deck"}', "DJ Deck", "dj deck"),
        ('{"prompt": "A long sentence (with notes)"}', "A Long Sentence", "a long sentence"),
    ],
)
def test_the_label_is_derived_from_the_prompt(raw: str, label: str, prompt: str) -> None:
    assert parse_label(raw) == {"label": label, "prompt": prompt}


@pytest.mark.parametrize("raw", ["not json", "[]", "{}", '{"label": "", "prompt": ""}'])
def test_a_useless_label_reply_is_an_error(raw: str) -> None:
    with pytest.raises(RuntimeError):
        parse_label(raw)


FACTS: SoundSummaryFacts = {
    "label": "Piano",
    "tempo_bpm": 96,
    "key": "A minor",
    "duration_seconds": 30,
    "low_midi": 48,
    "high_midi": 79,
    "low_note": "C3",
    "high_note": "G5",
    "entry_bar": 2,
    "note_count": 120,
}


@pytest.mark.parametrize(
    "summary",
    [
        "A piano at 96 BPM that enters at bar 2.",
        "It plays 120 notes between C3 and G5 over 30 seconds.",
        "A gentle part with no numbers at all.",
    ],
)
def test_a_summary_may_use_the_facts_it_was_given(summary: str) -> None:
    assert summary_numbers_are_allowed(summary, FACTS)


@pytest.mark.parametrize(
    "summary",
    [
        "A piano at 97 BPM.",
        "It reaches A6 at the end.",
        "It runs between pitch 48 and 79.",
        "",
        "   ",
    ],
)
def test_a_summary_with_an_invented_number_or_note_is_refused(summary: str) -> None:
    assert not summary_numbers_are_allowed(summary, FACTS)


@pytest.mark.parametrize(("pitch", "name"), [(60, "C4"), (69, "A4"), (21, "A0"), (61, "C#4")])
def test_midi_note_names(pitch: int, name: str) -> None:
    assert midi_note_name(pitch) == name


def _recipe() -> dict[str, object]:
    envelope = {"attack_ms": 5, "decay_ms": 200, "sustain": 0.5, "release_ms": 300}
    return {
        "summary": "A warm saw lead.",
        "oscillators": [
            {"wave": "saw", "count": 2, "unison": 3, "detune_cents": 12, "mix": 0.8},
        ],
        "filter": {"type": "lowpass", "cutoff_hz": 2000, "resonance": "low", "character": "warm"},
        "amp_env": envelope,
        "filter_env": {**envelope, "amount": 0.4},
        "fx": [{"type": "reverb", "mix": 0.2, "settings": "small room"}],
    }


def test_a_good_recipe_passes_and_voices_follow_unison() -> None:
    parsed = parse_recipe(json.dumps(_recipe()))
    assert parsed["summary"] == "A warm saw lead."
    assert parsed["oscillators"][0]["voices"] == 3
    assert parsed["filter_env"]["amount"] == 0.4


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("oscillators", []),
        ("oscillators", [{"wave": "saw"}]),
        ("oscillators", [{"wave": "saw", "count": 0, "unison": 1, "detune_cents": 0, "mix": 1}]),
        ("oscillators", [{"wave": "saw", "count": 1, "unison": 1, "detune_cents": 500, "mix": 1}]),
        ("oscillators", [{"wave": "saw", "count": 1, "unison": 1, "detune_cents": 0, "mix": 2}]),
        ("filter", {"type": "lp", "cutoff_hz": 1, "resonance": "low", "character": "warm"}),
        ("amp_env", {"attack_ms": -1, "decay_ms": 1, "sustain": 0.5, "release_ms": 1}),
        ("amp_env", {"attack_ms": 1, "decay_ms": 1, "sustain": 2, "release_ms": 1}),
        ("fx", "reverb"),
        ("fx", [{"type": "reverb", "mix": 3, "settings": "x"}]),
        ("summary", ""),
    ],
)
def test_muse_spark_open_ignores_the_schema_so_a_bad_recipe_is_refused(
    field: str, value: object
) -> None:
    recipe = _recipe()
    recipe[field] = value
    with pytest.raises(RuntimeError):
        parse_recipe(json.dumps(recipe))
