"""FastAPI application factory and HTTP routes for the Mixray engine."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import time
from collections.abc import Callable
from email.parser import BytesParser
from email.policy import default as default_email_policy
from pathlib import Path
from typing import TypedDict

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field, StrictInt, ValidationError

from ingest import (
    MAX_UPLOAD_BYTES,
    IngestError,
    IngestParams,
    JobRecord,
    JobStage,
    JobStatus,
    build_served_trackmap,
    check_and_increment_quota,
    clip_dir,
    get_cache_root,
    ingest_upload,
    isolation_id_for,
    read_job,
    write_job,
)
from label import RegionBounds

LOGGER = logging.getLogger(__name__)

CORS_ENV = "MIXRAY_CORS_ORIGINS"
API_KEY_ENV = "MIXRAY_API_KEY"
DEV_NO_AUTH_ENV = "MIXRAY_DEV_NO_AUTH"
DEFAULT_CORS_ORIGINS = (
    "https://mixray.vercel.app",
    "https://mixray.dev",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
)
MAX_PROMPT_LEN = 120
MIN_AREA_PIXELS = 16
TRACK_ID_RE = re.compile(r"area\d+x\d+x\d+x\d+f\d+")
SIGNED_TOKEN_PARTS = 2
TRACKMAP_PATH_PARTS = 3
CLIPS_DIRECTORY = "clips"
TRACKMAP_FILE_NAME = "trackmap.json"

MEDIA_TYPES: dict[str, str] = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".json": "application/json",
    ".jpg": "image/jpeg",
}

IsolationSpawner = Callable[[str, str, str, str], object]
AreaIsolationSpawner = Callable[[str, RegionBounds, int], object]
FollowSpawner = Callable[[str, str], object]
AnalysisSpawner = Callable[[str], object]
VolumeHook = Callable[[], object]
FileRoute = Callable[[str], Response]


class MultipartUpload(TypedDict):
    """Parsed fields from a multipart/form-data upload request."""

    filename: str
    payload: bytes
    fields: dict[str, str]


class RuntimeHooks(TypedDict):
    """Modal volume and worker hooks injected into the FastAPI routes."""

    spawn_isolation: IsolationSpawner | None
    spawn_area_isolation: AreaIsolationSpawner | None
    spawn_follow: FollowSpawner | None
    spawn_analysis: AnalysisSpawner | None
    commit: Callable[[], None]
    reload: Callable[[], None]


class HealthResponse(BaseModel):
    """Response returned by the health endpoint."""

    ok: bool


class IsolateRequest(BaseModel):
    """Request body for POST /jobs/{job_id}/isolate."""

    prompt: str = Field(..., min_length=1, max_length=MAX_PROMPT_LEN)
    label: str | None = Field(default=None, max_length=MAX_PROMPT_LEN)


class TrackRequest(BaseModel):
    """Request body for POST /jobs/{job_id}/track."""

    left: StrictInt = Field(..., ge=0)
    top: StrictInt = Field(..., ge=0)
    right: StrictInt = Field(..., ge=0)
    bottom: StrictInt = Field(..., ge=0)
    frame: StrictInt = Field(default=0, ge=0)


class FollowResponse(BaseModel):
    """Response returned when following a named area has been queued."""

    masks_url: str


class JobResponse(BaseModel):
    """Response returned by job creation, isolation, and polling endpoints."""

    id: str
    status: JobStatus
    stage: JobStage
    trackmap_url: str
    isolation_id: str | None = None
    cached: bool = False
    error: str | None = None


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    if request.client and request.client.host:
        return request.client.host
    return "127.0.0.1"


def _extract_token(request: Request) -> str:
    auth_header = request.headers.get("authorization", "").strip()
    if auth_header.lower().startswith("bearer "):
        return auth_header[7:].strip()
    return request.headers.get("x-api-key", "").strip()


def _verify_signed_token(token: str, secret: str) -> bool:
    parts = token.split(".")
    if len(parts) != SIGNED_TOKEN_PARTS:
        return False
    expiry_str, signature = parts
    if not expiry_str.isdigit():
        return False
    if int(expiry_str) < int(time.time()):
        return False
    expected = hmac.new(
        secret.encode("utf-8"), expiry_str.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)


def _require_auth(request: Request) -> None:
    secret = os.environ.get(API_KEY_ENV, "").strip()
    if not secret:
        if os.environ.get(DEV_NO_AUTH_ENV) == "1":
            return
        raise HTTPException(
            status_code=503,
            detail="MIXRAY_API_KEY is not configured on the engine.",
        )
    token = _extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="Missing API key.")
    if hmac.compare_digest(token, secret) or _verify_signed_token(token, secret):
        return
    raise HTTPException(status_code=401, detail="Invalid API key.")


def _parse_multipart(content_type: str, body: bytes) -> MultipartUpload:
    if "multipart/form-data" not in content_type.lower():
        raise IngestError("Expected multipart/form-data upload.")
    if len(body) > MAX_UPLOAD_BYTES + 65_536:
        raise IngestError("File exceeds the 50 MB limit.", status_code=413)
    header_bytes = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1")
    msg = BytesParser(policy=default_email_policy).parsebytes(header_bytes + body)
    if not msg.is_multipart():
        raise IngestError("Malformed multipart/form-data body.")

    filename = ""
    file_payload = b""
    fields: dict[str, str] = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        part_filename = part.get_filename()
        raw = part.get_payload(decode=True)
        payload_bytes = raw if isinstance(raw, bytes) else b""
        if part_filename is not None or name == "file":
            filename = part_filename or "upload.wav"
            file_payload = payload_bytes
        elif isinstance(name, str):
            fields[name] = payload_bytes.decode("utf-8", errors="replace").strip()

    if not filename or len(file_payload) == 0:
        raise IngestError("Missing 'file' part in multipart upload.")
    return {"filename": filename, "payload": file_payload, "fields": fields}


def _parse_float_field(fields: dict[str, str], key: str, default: float | None) -> float | None:
    raw = fields.get(key)
    if raw is None or raw == "":
        return default
    try:
        value = float(raw)
    except ValueError as err:
        raise IngestError(f"Invalid numeric value for '{key}'.") from err
    return value


def _to_job_response(record: JobRecord) -> JobResponse:
    return JobResponse(
        id=record["id"],
        status=record["status"],
        stage=record["stage"],
        trackmap_url=record["trackmap_url"],
        isolation_id=record["isolation_id"],
        cached=record["cached"],
        error=record["error"],
    )


def _cors_origins() -> list[str]:
    origins_env = os.environ.get(CORS_ENV, "")
    if origins_env:
        return [item.strip() for item in origins_env.split(",") if item.strip()]
    return list(DEFAULT_CORS_ORIGINS)


def _trackmap_clip_id(file_path: str) -> str | None:
    """Return a clip ID only for the assembled TrackMap endpoint path."""
    clean_path = file_path.strip("/")
    path_parts = clean_path.split("/")
    if (
        len(path_parts) == TRACKMAP_PATH_PARTS
        and path_parts[0] == CLIPS_DIRECTORY
        and path_parts[2] == TRACKMAP_FILE_NAME
    ):
        return path_parts[1]
    return None


def _file_route(reload_volume: Callable[[], None]) -> FileRoute:
    """Build the file route, serving TrackMaps from their assembled sidecars."""

    def get_file(file_path: str) -> Response:
        root = get_cache_root().resolve()
        clean_path = file_path.strip("/")
        candidate = (root / clean_path).resolve()
        if not candidate.is_relative_to(root):
            raise HTTPException(status_code=400, detail="Invalid file path.")
        trackmap_clip_id = _trackmap_clip_id(clean_path)
        if trackmap_clip_id is not None:
            reload_volume()
            try:
                trackmap = build_served_trackmap(trackmap_clip_id, root)
            except FileNotFoundError as error:
                raise HTTPException(status_code=404, detail="File not found.") from error
            return JSONResponse(
                content=trackmap,
                media_type=MEDIA_TYPES[".json"],
                headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
            )
        # A sidecar can be rewritten after it was first served - a summary is regenerated, a
        # recipe arrives late, a track is re-tracked - and the container's view of the Volume does
        # not move on its own. Reloading only when the file is MISSING served a stale summary for a
        # file that had already been overwritten, so a rewritable file is reloaded every time and
        # never cached. Media keeps the long cache: an isolation's id is derived from its content,
        # so its audio never changes under the same URL.
        rewritable = candidate.suffix.lower() == ".json"
        if rewritable or not candidate.is_file():
            reload_volume()
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="File not found.")
        media_type = MEDIA_TYPES.get(candidate.suffix.lower(), "application/octet-stream")
        cache_control = (
            "no-cache, no-store, must-revalidate" if rewritable else "public, max-age=86400"
        )
        return FileResponse(
            path=candidate,
            media_type=media_type,
            headers={"Cache-Control": cache_control},
        )

    return get_file


def _start_or_reuse_isolation(
    job_id: str,
    body: IsolateRequest,
    client_ip: str,
    hooks: RuntimeHooks,
) -> JobResponse:
    hooks["reload"]()
    root = get_cache_root()
    target_dir = clip_dir(job_id, root)
    if not (target_dir / "trackmap.json").exists():
        raise HTTPException(status_code=404, detail="Clip not found.")

    prompt = " ".join(body.prompt.strip().split())
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt must not be empty.")
    label = (body.label or prompt.capitalize()).strip()
    iso_id = isolation_id_for(job_id, prompt)
    cached_json = target_dir / "isolations" / iso_id / "isolation.json"
    trackmap_url = f"/files/clips/{job_id}/trackmap.json"

    if cached_json.exists():
        done_record = write_job(
            {
                "id": job_id,
                "status": "done",
                "stage": "done",
                "trackmap_url": trackmap_url,
                "isolation_id": iso_id,
                "cached": True,
                "error": None,
                "updated_at": time.time(),
            },
            root,
        )
        hooks["commit"]()
        return _to_job_response(done_record)

    try:
        check_and_increment_quota(client_ip, "isolations", root)
    except IngestError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error

    running_record = write_job(
        {
            "id": job_id,
            "status": "running",
            "stage": "isolating",
            "trackmap_url": trackmap_url,
            "isolation_id": iso_id,
            "cached": False,
            "error": None,
            "updated_at": time.time(),
        },
        root,
    )
    hooks["commit"]()
    spawner = hooks["spawn_isolation"]
    if spawner is not None:
        spawner(job_id, iso_id, prompt, label)
        hooks["reload"]()
        latest = read_job(job_id, root)
        if latest is not None:
            return _to_job_response(latest)
    return _to_job_response(running_record)


def _validate_track_request(job_id: str, body: TrackRequest, root: Path) -> None:
    """Confirm that an area addresses a stored video frame before charging quota."""
    trackmap_path = clip_dir(job_id, root) / TRACKMAP_FILE_NAME
    if not trackmap_path.exists():
        raise HTTPException(status_code=404, detail="Clip not found.")
    try:
        trackmap = json.loads(trackmap_path.read_text(encoding="utf-8"))
        video = trackmap.get("video") if isinstance(trackmap, dict) else None
        width = video.get("width") if isinstance(video, dict) else None
        height = video.get("height") if isinstance(video, dict) else None
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(status_code=400, detail="Video clip is unavailable.") from error
    if (
        isinstance(width, bool)
        or not isinstance(width, int)
        or width <= 0
        or isinstance(height, bool)
        or not isinstance(height, int)
        or height <= 0
    ):
        raise HTTPException(status_code=400, detail="Area selection requires a video clip.")
    if body.right > width or body.bottom > height:
        raise HTTPException(status_code=400, detail="That area is outside the video frame.")
    if body.right - body.left < MIN_AREA_PIXELS or body.bottom - body.top < MIN_AREA_PIXELS:
        raise HTTPException(status_code=400, detail="Draw a larger area.")
    frame_path = clip_dir(job_id, root) / "frames" / f"frame_{body.frame + 1:04d}.jpg"
    if not frame_path.is_file():
        raise HTTPException(status_code=400, detail="Frame is outside the video clip.")


def _start_follow(
    job_id: str, track_id: str, client_ip: str, hooks: RuntimeHooks
) -> FollowResponse:
    """Queue SAM 3.1 tracking for one named area, unless it has been followed already."""
    if TRACK_ID_RE.fullmatch(track_id) is None:
        raise HTTPException(status_code=404, detail="Area not found.")
    hooks["reload"]()
    root = get_cache_root()
    path = clip_dir(job_id, root) / "tracks" / f"{track_id}.json"
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Area not found.")
    masks_url = f"/files/clips/{job_id}/tracks/{track_id}.json"
    spawner = hooks["spawn_follow"]
    track = json.loads(path.read_text(encoding="utf-8"))
    if spawner is None or (isinstance(track, dict) and track.get("frames")):
        return FollowResponse(masks_url=masks_url)
    # A retry must not read the previous attempt's failure while the new one runs.
    if isinstance(track, dict) and track.pop("follow_error", None) is not None:
        path.write_text(json.dumps(track), encoding="utf-8")
    try:
        check_and_increment_quota(client_ip, "isolations", root)
    except IngestError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    hooks["commit"]()
    spawner(job_id, track_id)
    return FollowResponse(masks_url=masks_url)


def _start_area_isolation(
    job_id: str, body: TrackRequest, client_ip: str, hooks: RuntimeHooks
) -> JobResponse:
    """Queue area-to-text isolation after charging the usual isolation quota."""
    hooks["reload"]()
    root = get_cache_root()
    _validate_track_request(job_id, body, root)
    try:
        check_and_increment_quota(client_ip, "isolations", root)
    except IngestError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error

    trackmap_url = f"/files/clips/{job_id}/trackmap.json"
    running_record = write_job(
        {
            "id": job_id,
            "status": "running",
            "stage": "naming",
            "trackmap_url": trackmap_url,
            "isolation_id": None,
            "cached": False,
            "error": None,
            "updated_at": time.time(),
        },
        root,
    )
    hooks["commit"]()
    spawner = hooks["spawn_area_isolation"]
    if spawner is not None:
        bounds: RegionBounds = {
            "left": body.left,
            "top": body.top,
            "right": body.right,
            "bottom": body.bottom,
        }
        spawner(job_id, bounds, body.frame)
        hooks["reload"]()
        latest = read_job(job_id, root)
        if latest is not None:
            return _to_job_response(latest)
    return _to_job_response(running_record)


def _start_analysis(record: JobRecord, hooks: RuntimeHooks) -> JobRecord:
    """Start analysis for a fresh clip and persist its running job state."""
    analysis_spawner = hooks["spawn_analysis"]
    if record["cached"] or analysis_spawner is None:
        return record
    analyzing_record: JobRecord = {
        "id": record["id"],
        "status": "running",
        "stage": "analyzing",
        "trackmap_url": record["trackmap_url"],
        "isolation_id": record["isolation_id"],
        "cached": False,
        "error": None,
        "updated_at": time.time(),
    }
    updated_record = write_job(analyzing_record)
    hooks["commit"]()
    analysis_spawner(updated_record["id"])
    return updated_record


def get_health() -> HealthResponse:
    """Return the engine health status."""
    return HealthResponse(ok=True)


def create_api(  # noqa: PLR0913, PLR0917
    spawn_isolation: IsolationSpawner | None = None,
    spawn_area_isolation: AreaIsolationSpawner | None = None,
    spawn_follow: FollowSpawner | None = None,
    spawn_analysis: AnalysisSpawner | None = None,
    commit_volume: VolumeHook | None = None,
    reload_volume: VolumeHook | None = None,
) -> FastAPI:
    """Create the engine HTTP API."""
    api = FastAPI()
    api.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS", "HEAD"],
        allow_headers=["*"],
    )

    def _commit() -> None:
        if commit_volume is not None:
            commit_volume()

    def _reload() -> None:
        if reload_volume is not None:
            try:
                reload_volume()
            except Exception:
                LOGGER.warning("Volume reload failed; proceeding with local disk cache.")

    hooks: RuntimeHooks = {
        "spawn_isolation": spawn_isolation,
        "spawn_area_isolation": spawn_area_isolation,
        "spawn_follow": spawn_follow,
        "spawn_analysis": spawn_analysis,
        "commit": _commit,
        "reload": _reload,
    }

    async def post_job(request: Request) -> JobResponse:
        _require_auth(request)
        try:
            body = await request.body()
            parsed = _parse_multipart(request.headers.get("content-type", ""), body)
            clip_start = _parse_float_field(parsed["fields"], "clip_start", 0.0) or 0.0
            clip_end = _parse_float_field(parsed["fields"], "clip_end", None)
            params: IngestParams = {
                "filename": parsed["filename"],
                "payload": parsed["payload"],
                "clip_start": clip_start,
                "clip_end": clip_end,
                "title": parsed["fields"].get("title"),
                "client_ip": _client_ip(request),
            }
            record = ingest_upload(params)
            _commit()
            record = _start_analysis(record, hooks)
            return _to_job_response(record)
        except IngestError as error:
            raise HTTPException(status_code=error.status_code, detail=str(error)) from error

    def post_isolate(job_id: str, body: IsolateRequest, request: Request) -> JobResponse:
        _require_auth(request)
        return _start_or_reuse_isolation(job_id, body, _client_ip(request), hooks)

    async def post_track(job_id: str, request: Request) -> JobResponse:
        _require_auth(request)
        try:
            body = TrackRequest.model_validate(await request.json())
        except (json.JSONDecodeError, ValidationError) as error:
            raise HTTPException(
                status_code=400,
                detail="An area needs integer left, top, right and bottom and a frame index.",
            ) from error
        return _start_area_isolation(job_id, body, _client_ip(request), hooks)

    def post_follow(job_id: str, track_id: str, request: Request) -> FollowResponse:
        _require_auth(request)
        return _start_follow(job_id, track_id, _client_ip(request), hooks)

    def get_job(job_id: str, request: Request) -> JobResponse:
        _require_auth(request)
        _reload()
        record = read_job(job_id, get_cache_root())
        if record is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        return _to_job_response(record)

    api.add_api_route("/health", get_health, methods=["GET"], response_model=HealthResponse)
    api.add_api_route("/jobs", post_job, methods=["POST"], response_model=JobResponse)
    api.add_api_route(
        "/jobs/{job_id}/isolate", post_isolate, methods=["POST"], response_model=JobResponse
    )
    api.add_api_route(
        "/jobs/{job_id}/track", post_track, methods=["POST"], response_model=JobResponse
    )
    api.add_api_route(
        "/jobs/{job_id}/tracks/{track_id}/follow",
        post_follow,
        methods=["POST"],
        response_model=FollowResponse,
    )
    api.add_api_route("/jobs/{job_id}", get_job, methods=["GET"], response_model=JobResponse)
    api.add_api_route(
        "/files/{file_path:path}",
        _file_route(_reload),
        methods=["GET", "HEAD"],
        response_class=Response,
    )
    return api
