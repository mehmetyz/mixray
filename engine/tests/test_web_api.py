"""The engine's HTTP surface: who gets in, what is refused, and what reaches a worker."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from conftest import tone_wav
from fastapi.testclient import TestClient

from ingest import clip_dir, isolation_id_for, read_job
from label import RegionBounds
from web import _verify_signed_token, create_api

SECRET = "mixray-test-secret"
AUTH = {"authorization": f"Bearer {SECRET}"}
# The same pair is asserted in apps/web/tests/engine-token.test.ts, so the token the web mints and
# the token the engine accepts cannot drift apart unnoticed.
FAR_FUTURE_EXPIRY = "4102444800"
FAR_FUTURE_SIGNATURE = "7f0b07530d8d8e616d9d75632daf97348c74b7a0fef496a2836962a203531d15"


class Workers:
    """Records what would have been queued on Modal."""

    def __init__(self) -> None:
        self.isolations: list[tuple[str, str, str, str]] = []
        self.areas: list[tuple[str, RegionBounds, int]] = []
        self.follows: list[tuple[str, str]] = []
        self.analyses: list[str] = []

    def spawn_isolation(self, clip: str, iso: str, prompt: str, label: str) -> None:
        self.isolations.append((clip, iso, prompt, label))

    def spawn_area(self, clip: str, bounds: RegionBounds, frame: int) -> None:
        self.areas.append((clip, bounds, frame))

    def spawn_follow(self, clip: str, track: str) -> None:
        self.follows.append((clip, track))

    def spawn_analysis(self, clip: str) -> None:
        self.analyses.append(clip)


@pytest.fixture
def workers() -> Workers:
    return Workers()


@pytest.fixture
def client(
    cache_root: Path, workers: Workers, monkeypatch: pytest.MonkeyPatch
) -> Iterator[TestClient]:
    monkeypatch.setenv("MIXRAY_API_KEY", SECRET)
    monkeypatch.delenv("MIXRAY_DEV_NO_AUTH", raising=False)
    api = create_api(
        workers.spawn_isolation, workers.spawn_area, workers.spawn_follow, workers.spawn_analysis
    )
    with TestClient(api) as test_client:
        yield test_client


def _upload_clip(client: TestClient, payload: bytes | None = None) -> str:
    response = client.post(
        "/jobs",
        headers=AUTH,
        files={"file": ("clip.wav", payload or tone_wav(), "audio/wav")},
        data={"title": "Test tone"},
    )
    assert response.status_code == 200, response.text
    clip_id: str = response.json()["id"]
    return clip_id


def test_health_is_open(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"ok": True}


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/jobs/abc"),
        ("POST", "/jobs"),
        ("POST", "/jobs/abc/isolate"),
        ("POST", "/jobs/abc/track"),
        ("POST", "/jobs/abc/tracks/area1x1x1x1f1/follow"),
    ],
)
def test_every_job_route_needs_a_key(client: TestClient, method: str, path: str) -> None:
    response = client.request(method, path, json={"prompt": "piano"})
    assert response.status_code == 401


def test_a_wrong_key_is_refused(client: TestClient) -> None:
    response = client.get("/jobs/abc", headers={"authorization": "Bearer wrong"})
    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid API key."


def test_the_key_also_works_as_a_header(client: TestClient) -> None:
    assert client.get("/jobs/abc", headers={"x-api-key": SECRET}).status_code == 404


def test_without_a_configured_key_the_engine_stays_closed(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MIXRAY_API_KEY")
    assert client.get("/jobs/abc", headers=AUTH).status_code == 503


def test_local_development_can_switch_auth_off_explicitly(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("MIXRAY_API_KEY")
    monkeypatch.setenv("MIXRAY_DEV_NO_AUTH", "1")
    assert client.get("/jobs/abc").status_code == 404


def _signed(secret: str, expiry: int) -> str:
    signature = hmac.new(secret.encode(), str(expiry).encode(), hashlib.sha256).hexdigest()
    return f"{expiry}.{signature}"


def test_the_token_the_web_mints_opens_the_engine(client: TestClient) -> None:
    token = _signed(SECRET, int(time.time()) + 60)
    response = client.get("/jobs/abc", headers={"authorization": f"Bearer {token}"})
    assert response.status_code == 404


def test_the_token_format_matches_the_web_route() -> None:
    assert _verify_signed_token(f"{FAR_FUTURE_EXPIRY}.{FAR_FUTURE_SIGNATURE}", SECRET)


@pytest.mark.parametrize(
    "token",
    [
        _signed(SECRET, int(time.time()) - 1),
        _signed("another-secret", int(time.time()) + 60),
        "notatoken",
        "abc.def",
        "1.2.3",
    ],
)
def test_expired_forged_or_malformed_tokens_are_refused(client: TestClient, token: str) -> None:
    response = client.get("/jobs/abc", headers={"authorization": f"Bearer {token}"})
    assert response.status_code == 401


def test_an_upload_starts_analysis_and_can_be_read_back(
    client: TestClient, workers: Workers
) -> None:
    clip_id = _upload_clip(client)
    assert workers.analyses == [clip_id]
    job = client.get(f"/jobs/{clip_id}", headers=AUTH)
    assert job.status_code == 200
    assert job.json()["id"] == clip_id
    trackmap = client.get(f"/files/clips/{clip_id}/trackmap.json", headers=AUTH)
    assert trackmap.status_code == 200
    assert trackmap.headers["cache-control"].startswith("no-cache")
    assert trackmap.json()["id"] == clip_id


def test_an_upload_that_is_not_a_form_is_refused(client: TestClient) -> None:
    response = client.post(
        "/jobs", headers={**AUTH, "content-type": "application/json"}, content=b"{}"
    )
    assert response.status_code == 400
    assert "multipart" in response.json()["detail"]


def test_an_upload_quota_answers_429(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MIXRAY_DAILY_CLIP_QUOTA", "0")
    response = client.post(
        "/jobs", headers=AUTH, files={"file": ("clip.wav", tone_wav(), "audio/wav")}
    )
    assert response.status_code == 429


def test_isolating_queues_one_worker_with_the_clean_prompt(
    client: TestClient, workers: Workers, cache_root: Path
) -> None:
    clip_id = _upload_clip(client)
    response = client.post(
        f"/jobs/{clip_id}/isolate",
        headers=AUTH,
        json={"prompt": "  grand   piano ", "label": "Piano"},
    )
    assert response.status_code == 200
    body = response.json()
    iso_id = isolation_id_for(clip_id, "grand piano")
    assert body["status"] == "running"
    assert body["isolation_id"] == iso_id
    assert workers.isolations == [(clip_id, iso_id, "grand piano", "Piano")]
    assert read_job(clip_id, cache_root) is not None


def test_a_sound_already_separated_is_served_without_a_worker_or_a_charge(
    client: TestClient, workers: Workers, cache_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clip_id = _upload_clip(client)
    iso_id = isolation_id_for(clip_id, "piano")
    iso_dir = clip_dir(clip_id, cache_root) / "isolations" / iso_id
    iso_dir.mkdir(parents=True)
    (iso_dir / "isolation.json").write_text(json.dumps({"id": iso_id}), encoding="utf-8")
    monkeypatch.setenv("MIXRAY_DAILY_ISOLATION_QUOTA", "0")

    response = client.post(f"/jobs/{clip_id}/isolate", headers=AUTH, json={"prompt": "Piano"})

    assert response.status_code == 200
    assert response.json()["cached"] is True
    assert response.json()["status"] == "done"
    assert workers.isolations == []


def test_the_isolation_quota_stops_the_worker(
    client: TestClient, workers: Workers, monkeypatch: pytest.MonkeyPatch
) -> None:
    clip_id = _upload_clip(client)
    monkeypatch.setenv("MIXRAY_DAILY_ISOLATION_QUOTA", "0")
    response = client.post(f"/jobs/{clip_id}/isolate", headers=AUTH, json={"prompt": "piano"})
    assert response.status_code == 429
    assert workers.isolations == []


@pytest.mark.parametrize("body", [{}, {"prompt": ""}, {"prompt": "x" * 121}])
def test_a_bad_prompt_is_refused(client: TestClient, body: dict[str, str]) -> None:
    clip_id = _upload_clip(client)
    response = client.post(f"/jobs/{clip_id}/isolate", headers=AUTH, json=body)
    assert response.status_code == 422


def test_a_blank_prompt_is_refused(client: TestClient) -> None:
    clip_id = _upload_clip(client)
    response = client.post(f"/jobs/{clip_id}/isolate", headers=AUTH, json={"prompt": "   "})
    assert response.status_code == 400


def test_isolating_an_unknown_clip_is_404(client: TestClient) -> None:
    response = client.post("/jobs/absent/isolate", headers=AUTH, json={"prompt": "piano"})
    assert response.status_code == 404


def _video_clip(cache_root: Path, clip_id: str = "videoclip") -> str:
    directory = clip_dir(clip_id, cache_root)
    (directory / "frames").mkdir(parents=True)
    (directory / "frames" / "frame_0001.jpg").write_bytes(b"jpg")
    (directory / "trackmap.json").write_text(
        json.dumps({"video": {"width": 1280, "height": 720}}), encoding="utf-8"
    )
    return clip_id


AREA = {"left": 10, "top": 10, "right": 200, "bottom": 200, "frame": 0}


def test_a_drawn_area_goes_to_the_naming_worker(
    client: TestClient, workers: Workers, cache_root: Path
) -> None:
    clip_id = _video_clip(cache_root)
    response = client.post(f"/jobs/{clip_id}/track", headers=AUTH, json=AREA)
    assert response.status_code == 200
    assert len(workers.areas) == 1
    assert workers.areas[0][1] == {"left": 10, "top": 10, "right": 200, "bottom": 200}


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"right": 5000}, "outside the video"),
        ({"bottom": 5000}, "outside the video"),
        ({"right": 20}, "larger area"),
        ({"frame": 9}, "outside the video clip"),
    ],
)
def test_an_impossible_area_is_refused_before_any_charge(
    client: TestClient,
    workers: Workers,
    cache_root: Path,
    change: dict[str, int],
    message: str,
) -> None:
    clip_id = _video_clip(cache_root)
    response = client.post(f"/jobs/{clip_id}/track", headers=AUTH, json={**AREA, **change})
    assert response.status_code == 400
    assert message in response.json()["detail"]
    assert workers.areas == []
    assert not (cache_root / "quotas").exists()


@pytest.mark.parametrize(
    "content",
    [b'{"left": 1.5, "top": 0, "right": 100, "bottom": 100}', b'{"left": -1}', b"nonsense"],
)
def test_a_malformed_area_is_400(client: TestClient, cache_root: Path, content: bytes) -> None:
    clip_id = _video_clip(cache_root)
    response = client.post(
        f"/jobs/{clip_id}/track",
        headers={**AUTH, "content-type": "application/json"},
        content=content,
    )
    assert response.status_code == 400


def test_an_area_on_an_audio_clip_is_refused(client: TestClient) -> None:
    clip_id = _upload_clip(client)
    response = client.post(f"/jobs/{clip_id}/track", headers=AUTH, json=AREA)
    assert response.status_code == 400
    assert "video clip" in response.json()["detail"]


def test_files_cannot_leave_the_cache(client: TestClient, cache_root: Path) -> None:
    (cache_root.parent / "secret.txt").write_text("secret", encoding="utf-8")
    response = client.get("/files/%2e%2e/secret.txt")
    assert response.status_code in {400, 404}
    assert "secret" not in response.text


@pytest.mark.parametrize(
    "path",
    ["quotas/2026-11-02.json", "jobs/clip.json", "clips/%2e%2e/quotas/2026-11-02.json"],
)
def test_only_clips_are_served(client: TestClient, cache_root: Path, path: str) -> None:
    for directory, name in (("quotas", "2026-11-02.json"), ("jobs", "clip.json")):
        (cache_root / directory).mkdir(parents=True, exist_ok=True)
        (cache_root / directory / name).write_text('{"private": true}', encoding="utf-8")

    response = client.get(f"/files/{path}")

    assert response.status_code == 404
    assert "private" not in response.text


def test_a_missing_file_is_404(client: TestClient) -> None:
    assert client.get("/files/clips/absent/mix.mp3").status_code == 404
    assert client.get("/files/clips/absent/trackmap.json").status_code == 404


def test_media_is_cached_and_json_is_not(client: TestClient, cache_root: Path) -> None:
    clip_id = _upload_clip(client)
    media = client.get(f"/files/clips/{clip_id}/mix.mp3")
    assert media.status_code == 200
    assert media.headers["content-type"] == "audio/mpeg"
    assert "max-age" in media.headers["cache-control"]
    (cache_root / "clips" / clip_id / "note.json").write_text("{}", encoding="utf-8")
    sidecar = client.get(f"/files/clips/{clip_id}/note.json")
    assert sidecar.headers["cache-control"].startswith("no-cache")
