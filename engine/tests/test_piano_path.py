"""Piano through SAM Audio as a mask on the real mix, with its notes read from the Demucs stem."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from conftest import tone_wav

import transcribe
from fallback import masks_onto_mix, notes_from_demucs, route_for_prompt
from ingest import (
    IngestParams,
    build_served_trackmap,
    clip_dir,
    ingest_upload,
    isolation_id_for,
)


@pytest.mark.parametrize("prompt", ["piano", "grand piano", "Upright Pianos"])
def test_piano_takes_the_new_path(prompt: str) -> None:
    assert route_for_prompt(prompt) == "sam_candidates"
    assert masks_onto_mix(prompt)
    assert notes_from_demucs(prompt)


@pytest.mark.parametrize(
    "prompt", ["vocals", "bass", "guitar", "drums", "organ", "dog", "car horn"]
)
def test_other_sounds_keep_the_output_their_scores_were_measured_on(prompt: str) -> None:
    assert not masks_onto_mix(prompt)
    assert not notes_from_demucs(prompt)


def test_piano_notes_use_the_decoder_measured_for_piano_only() -> None:
    piano = transcribe._note_decoder("grand piano")
    assert piano == transcribe.PIANO_NOTE_DECODER
    assert piano.onset_threshold == 0.6
    assert piano.melodia_trick is False
    for other in ("lead vocals", "bass guitar", "acoustic guitar", None):
        assert transcribe._note_decoder(other) == transcribe.DEFAULT_NOTE_DECODER


def _clip(cache_root: Path) -> str:
    params: IngestParams = {
        "filename": "clip.wav",
        "payload": tone_wav(),
        "clip_start": 0.0,
        "clip_end": None,
        "title": "Test tone",
        "client_ip": "1.1.1.1",
    }
    return ingest_upload(params, cache_root)["id"]


def _isolation_on_disk(cache_root: Path, clip_id: str, directory: str, prompt: str) -> None:
    path = clip_dir(clip_id, cache_root) / "isolations" / directory / "isolation.json"
    path.parent.mkdir(parents=True)
    path.write_text(json.dumps({"id": directory, "prompt": prompt}), encoding="utf-8")


def test_a_result_from_an_older_algorithm_is_not_listed_beside_its_replacement(
    cache_root: Path,
) -> None:
    clip_id = _clip(cache_root)
    current = isolation_id_for(clip_id, "piano")
    _isolation_on_disk(cache_root, clip_id, current, "piano")
    _isolation_on_disk(cache_root, clip_id, "0123456789abcdef", "piano")

    served = build_served_trackmap(clip_id, cache_root)

    assert served["isolations"] == [{"id": current, "prompt": "piano"}]
