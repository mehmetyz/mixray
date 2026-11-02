"""Tune note decoding on Demucs piano stems of the develop pieces; report once on test pieces."""

from __future__ import annotations

import argparse
import itertools
import json
from collections.abc import Iterable
from dataclasses import asdict
from pathlib import Path

from decoding import Activations, activations_for, decode, load_model
from scoring import (
    ENGINE_DEFAULT,
    ENGINE_PIANO,
    DecoderSettings,
    Note,
    Score,
    mean_score,
    note_score,
)

GRID = tuple(
    DecoderSettings(*values)
    for values in itertools.product(
        (0.3, 0.4, 0.5, 0.6, 0.7), (0.2, 0.3, 0.4), (30.0, 58.0), (True, False)
    )
)
CONDITIONS = ("band", "steam", "solo")
TUNED_ON = ("band", "steam")

Piece = dict[str, object]
Case = tuple[str, str]


def _notes(piece: Piece) -> list[Note]:
    raw = piece["notes"]
    if not isinstance(raw, list):
        raise TypeError("labels.json holds no note list")
    return [(float(start), float(end), float(pitch)) for start, end, pitch in raw]


def _source(work: Path, name: str, condition: str) -> Path:
    if condition == "solo":
        return work / "mixes" / f"{name}__solo.wav"
    return work / "stems" / "htdemucs_6s" / f"{name}__{condition}" / "piano.wav"


def _scores(
    settings: DecoderSettings,
    cases: Iterable[Case],
    outputs: dict[Case, Activations],
    labels: dict[str, list[Note]],
) -> list[Score]:
    return [
        note_score(labels[name], decode(outputs[(name, cond)], settings)) for name, cond in cases
    ]


def _rounded(score: Score) -> dict[str, float]:
    return {field: round(value, 4) for field, value in score._asdict().items()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    arguments = parser.parse_args()

    pieces: dict[str, Piece] = json.loads((arguments.work / "labels.json").read_text("utf-8"))
    labels = {name: _notes(piece) for name, piece in pieces.items()}
    model = load_model()
    outputs: dict[Case, Activations] = {}
    for name in pieces:
        for condition in CONDITIONS:
            outputs[(name, condition)] = activations_for(
                _source(arguments.work, name, condition), model
            )
        print("predicted", name, flush=True)

    develop = [
        (name, condition)
        for name, piece in pieces.items()
        if piece["split"] == "develop"
        for condition in TUNED_ON
    ]
    table = sorted(
        ((mean_score(_scores(settings, develop, outputs, labels)), settings) for settings in GRID),
        key=lambda row: -row[0].f1,
    )
    chosen = table[0][1]
    print("chosen on develop, frozen:", chosen, flush=True)

    test_names = [name for name, piece in pieces.items() if piece["split"] == "test"]
    report: dict[str, object] = {
        "chosen_on_develop": asdict(chosen),
        "matches_engine": chosen == ENGINE_PIANO,
        "develop_top": [
            {"score": _rounded(score), "settings": asdict(settings)}
            for score, settings in table[:8]
        ],
        "test_pieces": len(test_names),
        "licences": {name: piece["licence"] for name, piece in pieces.items()},
        "notes_in_set": sum(len(notes) for notes in labels.values()),
    }
    for condition in CONDITIONS:
        cases = [(name, condition) for name in test_names]
        before = _scores(ENGINE_DEFAULT, cases, outputs, labels)
        after = _scores(chosen, cases, outputs, labels)
        engine = _scores(ENGINE_PIANO, cases, outputs, labels)
        report[condition] = {
            "old_default": _rounded(mean_score(before)),
            "chosen": _rounded(mean_score(after)),
            "engine_piano": _rounded(mean_score(engine)),
            "gain_per_piece": sorted(
                round(new.f1 - old.f1, 3) for new, old in zip(after, before, strict=True)
            ),
        }
    arguments.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("EVAL_DONE", flush=True)


if __name__ == "__main__":
    main()
