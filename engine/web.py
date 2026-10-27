"""FastAPI application factory and HTTP routes for the Mixray engine."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from collections.abc import Callable
from email.parser import BytesParser
from email.policy import default as default_email_policy
from typing import TypedDict

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ingest import (
    MAX_UPLOAD_BYTES,
    IngestError,
    IngestParams,
    IsolationEntry,
    JobRecord,
    JobStage,
    JobStatus,
    append_isolation_to_trackmap,
    check_and_increment_quota,
    clip_dir,
    get_cache_root,
    ingest_upload,
    isolation_id_for,
    read_job,
    write_job,
)

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
SIGNED_TOKEN_PARTS = 2

MEDIA_TYPES: dict[str, str] = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".json": "application/json",
    ".jpg": "image/jpeg",
}

IsolationSpawner = Callable[[str, str, str, str], object]
VolumeHook = Callable[[], object]


class MultipartUpload(TypedDict):
    """Parsed fields from a multipart/form-data upload request."""

    filename: str
    payload: bytes
    fields: dict[str, str]


class RuntimeHooks(TypedDict):
    """Modal volume and worker hooks injected into the FastAPI routes."""

    spawn_isolation: IsolationSpawner | None
    commit: Callable[[], None]
    reload: Callable[[], None]


class HealthResponse(BaseModel):
    """Response returned by the health endpoint."""

    ok: bool


class IsolateRequest(BaseModel):
    """Request body for POST /jobs/{job_id}/isolate."""

    prompt: str = Field(..., min_length=1, max_length=MAX_PROMPT_LEN)
    label: str | None = Field(default=None, max_length=MAX_PROMPT_LEN)


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
        entry: IsolationEntry = json.loads(cached_json.read_text(encoding="utf-8"))
        append_isolation_to_trackmap(job_id, entry, root)
        done_record = write_job(
            {
                "id": job_id,
                "status": "done",
                "stage": "done",
                "trackmap_url": trackmap_url,
                "isolation_id": iso_id,
                "cached": True,
                "error": None,
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


def get_health() -> HealthResponse:
    """Return the engine health status."""
    return HealthResponse(ok=True)


def create_api(
    spawn_isolation: IsolationSpawner | None = None,
    commit_volume: VolumeHook | None = None,
    reload_volume: VolumeHook | None = None,
) -> FastAPI:
    """Create the engine HTTP API."""
    api = FastAPI()
    api.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins(),
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    def _commit() -> None:
        if commit_volume is not None:
            commit_volume()

    def _reload() -> None:
        if reload_volume is not None:
            reload_volume()

    hooks: RuntimeHooks = {
        "spawn_isolation": spawn_isolation,
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
            return _to_job_response(record)
        except IngestError as error:
            raise HTTPException(status_code=error.status_code, detail=str(error)) from error

    def post_isolate(job_id: str, body: IsolateRequest, request: Request) -> JobResponse:
        _require_auth(request)
        return _start_or_reuse_isolation(job_id, body, _client_ip(request), hooks)

    def get_job(job_id: str, request: Request) -> JobResponse:
        _require_auth(request)
        _reload()
        record = read_job(job_id)
        if record is None:
            raise HTTPException(status_code=404, detail="Job not found.")
        return _to_job_response(record)

    def get_file(file_path: str) -> FileResponse:
        root = get_cache_root().resolve()
        candidate = (root / file_path).resolve()
        if not candidate.is_relative_to(root):
            raise HTTPException(status_code=400, detail="Invalid file path.")
        if not candidate.is_file():
            _reload()
        if not candidate.is_file():
            raise HTTPException(status_code=404, detail="File not found.")
        media_type = MEDIA_TYPES.get(candidate.suffix.lower(), "application/octet-stream")
        return FileResponse(
            path=candidate,
            media_type=media_type,
            headers={"Cache-Control": "public, max-age=86400"},
        )

    api.add_api_route("/health", get_health, methods=["GET"], response_model=HealthResponse)
    api.add_api_route("/jobs", post_job, methods=["POST"], response_model=JobResponse)
    api.add_api_route(
        "/jobs/{job_id}/isolate", post_isolate, methods=["POST"], response_model=JobResponse
    )
    api.add_api_route("/jobs/{job_id}", get_job, methods=["GET"], response_model=JobResponse)
    api.add_api_route("/files/{file_path:path}", get_file, methods=["GET"])
    return api
