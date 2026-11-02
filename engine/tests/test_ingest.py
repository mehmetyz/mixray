"""Upload to served TrackMap, through the real ffmpeg, against the schema the web validates with."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest
from conftest import tone_wav
from jsonschema import Draft202012Validator

from ingest import (
    MAX_UPLOAD_BYTES,
    IngestError,
    IngestParams,
    JobRecord,
    _validate_clip_window,
    build_served_trackmap,
    cleanup_expired_clips,
    clip_dir,
    has_suggestions,
    ingest_upload,
    isolation_id_for,
    read_job,
    trackmap_path,
    write_job,
)
from suggest import isolation_summary_facts
from transcribe import left_hand_accompaniment


def _upload(
    payload: bytes,
    filename: str = "clip.wav",
    clip_start: float = 0.0,
    clip_end: float | None = None,
) -> IngestParams:
    return {
        "filename": filename,
        "payload": payload,
        "clip_start": clip_start,
        "clip_end": clip_end,
        "title": "Test tone",
        "client_ip": "1.1.1.1",
    }


def _job(clip_id: str, status: str = "running") -> JobRecord:
    record: JobRecord = {
        "id": clip_id,
        "status": "running" if status == "running" else "done",
        "stage": "isolating",
        "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
        "isolation_id": None,
        "cached": False,
        "error": None,
    }
    return record


def test_an_unanalysed_clip_claims_no_tempo_key_or_chords(
    cache_root: Path, trackmap_validator: Draft202012Validator
) -> None:
    record = ingest_upload(_upload(tone_wav(seconds=2.0)), cache_root)

    trackmap = build_served_trackmap(record["id"], cache_root)

    trackmap_validator.validate(trackmap)
    tempo = trackmap["tempo"]
    key = trackmap["key"]
    assert isinstance(tempo, dict) and tempo["confidence"] == 0
    assert isinstance(key, dict) and key["confidence"] == 0
    assert trackmap["chords"] == []
    assert left_hand_accompaniment([], [0.0], []) == []
    with pytest.raises(ValueError, match="not measured"):
        isolation_summary_facts(trackmap, "any")


def test_an_upload_writes_playable_audio_and_a_valid_trackmap(
    cache_root: Path, trackmap_validator: Draft202012Validator
) -> None:
    record = ingest_upload(_upload(tone_wav(seconds=2.0)), cache_root)
    directory = clip_dir(record["id"], cache_root)

    assert (directory / "mix.wav").stat().st_size > 0
    assert (directory / "mix.mp3").stat().st_size > 0
    trackmap = build_served_trackmap(record["id"], cache_root)
    trackmap_validator.validate(trackmap)
    assert trackmap["id"] == record["id"]
    assert trackmap["duration"] == pytest.approx(2.0, abs=0.05)
    assert trackmap["suggestions"] == []
    assert trackmap["isolations"] == []


def test_the_clip_id_comes_from_the_audio_so_a_repeat_is_not_processed_twice(
    cache_root: Path,
) -> None:
    first = ingest_upload(_upload(tone_wav()), cache_root)
    second = ingest_upload(_upload(tone_wav(), filename="renamed.wav"), cache_root)
    other = ingest_upload(_upload(tone_wav(frequency=880.0)), cache_root)

    assert first["id"] == second["id"]
    assert first["id"] != other["id"]


def test_a_long_source_is_cut_to_the_chosen_window(cache_root: Path) -> None:
    record = ingest_upload(_upload(tone_wav(seconds=3.0), clip_start=1.0, clip_end=2.5), cache_root)
    trackmap = build_served_trackmap(record["id"], cache_root)
    assert trackmap["duration"] == pytest.approx(1.5, abs=0.05)


@pytest.mark.parametrize(
    ("params", "message"),
    [
        (_upload(b"anything", filename="clip.exe"), "Unsupported file type"),
        (_upload(b"", filename="clip.wav"), "empty"),
        (_upload(b"\0" * (MAX_UPLOAD_BYTES + 1)), "50 MB"),
    ],
)
def test_a_bad_upload_is_refused_with_a_sentence(
    cache_root: Path, params: IngestParams, message: str
) -> None:
    with pytest.raises(IngestError, match=message):
        ingest_upload(params, cache_root)


def test_bytes_that_are_not_media_are_refused(cache_root: Path) -> None:
    with pytest.raises(IngestError):
        ingest_upload(_upload(b"this is not audio at all"), cache_root)


def test_an_oversized_file_answers_413(cache_root: Path) -> None:
    with pytest.raises(IngestError) as caught:
        ingest_upload(_upload(b"\0" * (MAX_UPLOAD_BYTES + 1)), cache_root)
    assert caught.value.status_code == 413


@pytest.mark.parametrize(
    ("start", "end", "duration", "expected"),
    [
        (0.0, None, 10.0, (0.0, 10.0, 10.0)),
        (0.0, None, 300.0, (0.0, 30.0, 30.0)),
        (5.0, 15.0, 300.0, (5.0, 15.0, 10.0)),
        (5.0, 500.0, 20.0, (5.0, 20.0, 15.0)),
    ],
)
def test_the_clip_window_is_resolved(
    start: float,
    end: float | None,
    duration: float,
    expected: tuple[float, float, float],
) -> None:
    assert _validate_clip_window(start, end, duration) == expected


@pytest.mark.parametrize(
    ("start", "end", "duration", "message"),
    [
        (-1.0, None, 10.0, "within the media"),
        (10.0, None, 10.0, "within the media"),
        (1.0, 1.2, 10.0, "at least 0.5"),
        (0.0, 31.0, 60.0, "cannot exceed 30"),
    ],
)
def test_a_bad_clip_window_is_refused(
    start: float, end: float | None, duration: float, message: str
) -> None:
    with pytest.raises(IngestError, match=message):
        _validate_clip_window(start, end, duration)


def test_the_isolation_id_ignores_case_and_spacing() -> None:
    assert isolation_id_for("clip", "  Grand   PIANO ") == isolation_id_for("clip", "grand piano")


def test_the_isolation_id_depends_on_clip_and_prompt() -> None:
    reference = isolation_id_for("clip", "piano")
    assert len(reference) == 16
    assert reference != isolation_id_for("clip", "guitar")
    assert reference != isolation_id_for("other", "piano")


def test_a_job_reads_back_as_written(cache_root: Path) -> None:
    write_job(_job("clip"), cache_root)
    record = read_job("clip", cache_root)
    assert record is not None
    assert record["status"] == "running"
    assert record["stage"] == "isolating"


def test_a_missing_or_broken_job_is_none(cache_root: Path) -> None:
    assert read_job("absent", cache_root) is None
    (cache_root / "jobs").mkdir(exist_ok=True)
    (cache_root / "jobs" / "broken.json").write_text("{not json", encoding="utf-8")
    assert read_job("broken", cache_root) is None


def test_a_stalled_job_turns_into_an_error_instead_of_spinning_forever(cache_root: Path) -> None:
    record = _job("clip")
    record["updated_at"] = time.time() - 1_000
    write_job(record, cache_root)

    expired = read_job("clip", cache_root, timeout_seconds=600)

    assert expired is not None
    assert expired["status"] == "error"
    assert expired["error"] == "Operation timed out. Please try again."
    stored = read_job("clip", cache_root)
    assert stored is not None
    assert stored["status"] == "error"


def test_a_finished_job_never_expires(cache_root: Path) -> None:
    record = _job("clip", status="done")
    record["updated_at"] = time.time() - 1_000
    write_job(record, cache_root)
    finished = read_job("clip", cache_root, timeout_seconds=1)
    assert finished is not None
    assert finished["status"] == "done"


def _stored_clip(cache_root: Path) -> str:
    return ingest_upload(_upload(tone_wav()), cache_root)["id"]


def _write_sidecar(path: Path, content: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(content), encoding="utf-8")


def test_chips_come_only_from_muse_spark_never_from_the_stored_base(cache_root: Path) -> None:
    clip_id = _stored_clip(cache_root)
    path = trackmap_path(clip_id, cache_root)
    base = json.loads(path.read_text(encoding="utf-8"))
    base["suggestions"] = [{"label": "Synth lead", "prompt": "synth lead"}]
    path.write_text(json.dumps(base), encoding="utf-8")

    assert build_served_trackmap(clip_id, cache_root)["suggestions"] == []
    assert not has_suggestions(clip_id, cache_root)

    chip = {"label": "Piano", "prompt": "piano"}
    _write_sidecar(
        clip_dir(clip_id, cache_root) / "suggest.json",
        {"suggestions": [chip], "summary": "A quiet piano."},
    )
    served = build_served_trackmap(clip_id, cache_root)
    assert served["suggestions"] == [chip]
    assert served["summary"] == "A quiet piano."
    assert has_suggestions(clip_id, cache_root)


def test_a_broken_sidecar_or_track_does_not_take_the_clip_down(cache_root: Path) -> None:
    clip_id = _stored_clip(cache_root)
    directory = clip_dir(clip_id, cache_root)
    _write_sidecar(directory / "tracks" / "bad.json", {"id": 3})
    served = build_served_trackmap(clip_id, cache_root)
    assert served["isolations"] == []
    assert "video" not in served


def test_a_served_track_keeps_only_the_fields_the_schema_allows(
    cache_root: Path, trackmap_validator: Draft202012Validator
) -> None:
    clip_id = _stored_clip(cache_root)
    _write_sidecar(
        clip_dir(clip_id, cache_root) / "tracks" / "area1.json",
        {
            "id": "area1",
            "label": "Piano",
            "prompt": "piano",
            "visible": [[0.0, 1.0]],
            "frames": [],
            "selection": {"bounds": {"left": 0, "top": 0, "right": 10, "bottom": 10}, "frame": 0},
        },
    )
    served = build_served_trackmap(clip_id, cache_root)
    trackmap_validator.validate(served)
    video = served["video"]
    assert isinstance(video, dict)
    assert video["tracks"][0]["masks_url"] == f"/files/clips/{clip_id}/tracks/area1.json"
    assert "frames" not in video["tracks"][0]


def test_adding_a_clip_again_restarts_its_seven_days(cache_root: Path) -> None:
    clip_id = _stored_clip(cache_root)
    meta_path = clip_dir(clip_id, cache_root) / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["created_at"] = time.time() - 8 * 24 * 60 * 60
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    again = ingest_upload(_upload(tone_wav()), cache_root)

    assert again["cached"] is True
    cleanup_expired_clips(cache_root)
    assert clip_dir(clip_id, cache_root).exists()


def test_cleanup_deletes_clips_older_than_seven_days_and_keeps_the_rest(cache_root: Path) -> None:
    old_id = ingest_upload(_upload(tone_wav(frequency=220.0)), cache_root)["id"]
    new_id = ingest_upload(_upload(tone_wav(frequency=330.0)), cache_root)["id"]
    meta_path = clip_dir(old_id, cache_root) / "meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    meta["created_at"] = time.time() - 8 * 24 * 60 * 60
    meta_path.write_text(json.dumps(meta), encoding="utf-8")

    assert cleanup_expired_clips(cache_root) == 1

    assert not os.path.exists(cache_root / "clips" / old_id)
    assert read_job(old_id, cache_root) is None
    assert (cache_root / "clips" / new_id).is_dir()
