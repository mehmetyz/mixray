"""A chip whose sound is not in the audio is withdrawn once separation says so."""

from __future__ import annotations

import json
from pathlib import Path

from ingest import clip_dir
from suggest import drop_absent_suggestion

CLIP = "a" * 64


def _write_chips(cache_root: Path, prompts: list[str]) -> Path:
    directory = clip_dir(CLIP, cache_root)
    directory.mkdir(parents=True)
    path = directory / "suggest.json"
    chips = [{"label": p.title(), "prompt": p} for p in prompts]
    path.write_text(json.dumps({"suggestions": chips, "summary": "A piano by a rainy window."}))
    return path


def _prompts(path: Path) -> list[str]:
    return [chip["prompt"] for chip in json.loads(path.read_text())["suggestions"]]


def test_an_absent_sound_loses_its_chip(tmp_path: Path) -> None:
    path = _write_chips(tmp_path, ["digital piano", "rain"])
    assert drop_absent_suggestion(CLIP, "rain", tmp_path)
    assert _prompts(path) == ["digital piano"]
    assert json.loads(path.read_text())["summary"] == "A piano by a rainy window."


def test_the_same_instrument_under_another_name_is_matched(tmp_path: Path) -> None:
    path = _write_chips(tmp_path, ["electric guitar", "bass"])
    assert drop_absent_suggestion(CLIP, "guitar", tmp_path)
    assert _prompts(path) == ["bass"]


def test_other_chips_and_missing_sidecars_are_left_alone(tmp_path: Path) -> None:
    assert not drop_absent_suggestion(CLIP, "rain", tmp_path)
    path = _write_chips(tmp_path, ["digital piano"])
    assert not drop_absent_suggestion(CLIP, "violin", tmp_path)
    assert _prompts(path) == ["digital piano"]
