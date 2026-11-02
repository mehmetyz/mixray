"""Basic Pitch on GuitarSet's mic recordings against its published notes, split by player."""

from __future__ import annotations

import argparse
import json
from dataclasses import replace
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf
from decoding import activations_for, decode, load_model
from scoring import ENGINE_DEFAULT, ENGINE_GUITAR, Note, Score, mean_score, note_score

SAMPLE_RATE = 48_000
CLIP_SECONDS = 30.0
NOTE_NAMESPACE = "note_midi"
MINIMUM_NOTES = 20
DEVELOP_PLAYERS = ("00", "01", "02")
VARIANTS = (
    ("30 ms, the default", ENGINE_DEFAULT),
    ("100 ms, for reference", replace(ENGINE_DEFAULT, minimum_note_milliseconds=100.0)),
    ("127.7 ms, what the engine uses for guitar", ENGINE_GUITAR),
)


def notes_from_jams(path: Path, limit: float) -> list[Note]:
    """GuitarSet annotates each string apart; merge them. Pitches stay fractional, as published."""
    document = json.loads(path.read_text("utf-8"))
    merged: list[Note] = []
    for annotation in document.get("annotations", []):
        if annotation.get("namespace") != NOTE_NAMESPACE:
            continue
        for event in annotation.get("data", []):
            start = float(event["time"])
            end = start + float(event["duration"])
            if end > 0.0 and start < limit:
                merged.append((max(0.0, start), min(limit, end), float(event["value"])))
    return sorted(merged, key=lambda note: (note[0], note[2]))


def build_case(jams: Path, audio_root: Path, cases: Path) -> tuple[Path, list[Note]] | None:
    found = list(audio_root.rglob(f"{jams.stem}_mic.wav"))
    if not found:
        return None
    audio, rate = sf.read(str(found[0]), dtype="float64", always_2d=True)
    samples = audio.mean(axis=1)
    duration = min(CLIP_SECONDS, samples.size / rate)
    labels = notes_from_jams(jams, duration)
    if len(labels) < MINIMUM_NOTES:
        return None
    clip = samples[: round(duration * rate)]
    resampled = librosa.resample(clip, orig_sr=rate, target_sr=SAMPLE_RATE)
    path = cases / f"{jams.stem}.wav"
    sf.write(str(path), resampled.astype(np.float32), SAMPLE_RATE)
    return path, labels


def _summary(scores: list[Score]) -> dict[str, float]:
    return {field: round(value, 4) for field, value in mean_score(scores)._asdict().items()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audio", type=Path, required=True, help="unzipped audio_mono-mic")
    parser.add_argument("--annotations", type=Path, required=True, help="unzipped annotation")
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    arguments = parser.parse_args()

    cases = arguments.work / "guitar_cases"
    cases.mkdir(parents=True, exist_ok=True)
    model = load_model()
    results: dict[str, dict[str, list[Score]]] = {
        name: {"develop": [], "holdout": []} for name, _ in VARIANTS
    }
    counted = 0
    for jams in sorted(arguments.annotations.rglob("*.jams")):
        case = build_case(jams, arguments.audio, cases)
        if case is None:
            continue
        path, labels = case
        split = "develop" if jams.stem.split("_")[0] in DEVELOP_PLAYERS else "holdout"
        output = activations_for(path, model)
        for name, settings in VARIANTS:
            results[name][split].append(note_score(labels, decode(output, settings)))
        path.unlink()
        counted += 1
        if counted % 30 == 0:
            print(counted, "recordings", flush=True)

    report = {
        name: {split: {**_summary(scores), "n": len(scores)} for split, scores in splits.items()}
        for name, splits in results.items()
    }
    arguments.out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("EVAL_DONE", counted, flush=True)


if __name__ == "__main__":
    main()
