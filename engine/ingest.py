"""Ingest, cache storage, waveform peaks, TrackMap state, and quota helpers."""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import shutil
import struct
import subprocess
import tempfile
import time
import wave
from pathlib import Path
from typing import Literal, NotRequired, TypedDict

LOGGER = logging.getLogger(__name__)

CACHE_DIR_ENV = "MIXRAY_CACHE_DIR"
DEFAULT_CACHE_PATH = "/cache"

MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_SOURCE_DURATION_SECONDS = 360.0
MAX_CLIP_DURATION_SECONDS = 30.0
MIN_CLIP_DURATION_SECONDS = 0.5
CANONICAL_SAMPLE_RATE = 48_000
PEAKS_COUNT = 300
VIDEO_FPS = 10
MAX_VIDEO_FRAMES = 300
RETENTION_SECONDS = 7 * 24 * 60 * 60

DAILY_CLIP_QUOTA = 25
DAILY_ISOLATION_QUOTA = 50
DISABLE_QUOTA_ENV = "MIXRAY_DISABLE_QUOTA"
CLIP_QUOTA_ENV = "MIXRAY_DAILY_CLIP_QUOTA"
ISOLATION_QUOTA_ENV = "MIXRAY_DAILY_ISOLATION_QUOTA"

DEFAULT_BPM = 120.0
BEATS_PER_BAR = 4
SECONDS_PER_MINUTE = 60.0
ENERGY_HOP_SECONDS = 0.25
HASH_PREFIX_LEN = 16
DEFAULT_JOB_TIMEOUT_SECONDS = 600.0

AUDIO_EXTENSIONS = frozenset({".mp3", ".wav", ".flac", ".m4a", ".aac", ".ogg"})
VIDEO_EXTENSIONS = frozenset({".mp4", ".mov", ".webm", ".m4v"})
ALLOWED_EXTENSIONS = AUDIO_EXTENSIONS | VIDEO_EXTENSIONS

SourceKind = Literal["audio", "video"]
JobStatus = Literal["queued", "running", "done", "error"]
JobStage = Literal[
    "listening",
    "segmenting",
    "naming",
    "isolating",
    "analyzing",
    "done",
    "error",
]
IsolationMethod = Literal["sam_audio_text", "sam_audio_visual", "demucs", "unseparated"]


class IngestError(ValueError):
    """Raised when an upload fails validation or media decoding."""

    def __init__(self, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.status_code = status_code


class QuotaExceededError(IngestError):
    """Raised when an IP exceeds its daily clip or isolation allowance."""

    def __init__(self, message: str) -> None:
        super().__init__(message, status_code=429)


class MediaProbe(TypedDict):
    """Stream metadata returned by ffprobe."""

    duration: float
    has_video: bool
    width: int
    height: int


class ClipMeta(TypedDict):
    """Metadata persisted alongside each ingested clip."""

    id: str
    kind: SourceKind
    title: str
    clip_start: float
    clip_end: float
    duration: float
    created_at: float


class JobRecord(TypedDict):
    """Status document returned by GET /jobs/{id}."""

    id: str
    status: JobStatus
    stage: JobStage
    trackmap_url: str
    isolation_id: str | None
    cached: bool
    error: str | None
    updated_at: NotRequired[float]


class IpQuotaCounter(TypedDict):
    """Daily usage counts for a single client IP."""

    clips: int
    isolations: int


class IngestParams(TypedDict):
    """Validated parameters for ingesting one media upload."""

    filename: str
    payload: bytes
    clip_start: float
    clip_end: float | None
    title: str | None
    client_ip: str


class IsolationRange(TypedDict):
    """MIDI pitch range for an isolated part."""

    low: int
    high: int


class IsolationArrangements(TypedDict):
    """Keyboard arrangements for an isolated sound."""

    easy: list[dict[str, object]]
    intermediate: list[dict[str, object]]


class IsolationEntry(TypedDict):
    """One producer-owned isolation cache entry."""

    id: str
    label: str
    prompt: str
    method: IsolationMethod
    sound_url: str
    sound_wav_url: str
    rest_url: str
    peaks: list[float]
    rest_peaks: list[float]
    notes: list[dict[str, object]]
    arrangements: IsolationArrangements


ANALYSIS_FIELDS: tuple[str, ...] = (
    "tempo",
    "beats",
    "downbeats",
    "key",
    "chords",
    "sections",
    "energy",
)
# Per-isolation sidecars, as (file, field). A producer writes its own file and the assembler
# overlays it on read, because three containers read-modify-writing one trackmap lost results once.
# A file holding only its own field is unwrapped; anything else is taken whole.
ISOLATION_SIDECARS: tuple[tuple[str, str], ...] = (
    ("recipe.json", "recipe"),
    ("summary.json", "summary"),
)
TRANSCRIPTION_FIELDS: tuple[str, ...] = (
    "notes",
    "arrangements",
    "pitch_confidence",
    "range",
)


def get_cache_root() -> Path:
    """Return the active cache root directory, creating it if needed."""
    root = Path(os.environ.get(CACHE_DIR_ENV, DEFAULT_CACHE_PATH))
    root.mkdir(parents=True, exist_ok=True)
    return root


def clip_dir(clip_id: str, cache_root: Path | None = None) -> Path:
    """Return the directory holding all artifacts for a clip."""
    base = cache_root if cache_root is not None else get_cache_root()
    return base / "clips" / clip_id


def job_file(clip_id: str, cache_root: Path | None = None) -> Path:
    """Return the path to a clip's job status JSON file."""
    base = cache_root if cache_root is not None else get_cache_root()
    jobs_dir = base / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    return jobs_dir / f"{clip_id}.json"


# Part of the isolation cache key, bumped whenever separation or candidate ranking changes. The
# clip id is a hash of the audio, so without this a cache hit serves the previous algorithm's
# result for the same clip and prompt, and a re-run reads as a no-op improvement.
ISOLATION_ALGORITHM_VERSION = 7


def isolation_id_for(clip_id: str, prompt: str) -> str:
    """Compute a deterministic 16-hex-char isolation ID from clip ID, prompt and algorithm."""
    normalized = " ".join(prompt.strip().lower().split())
    key = f"v{ISOLATION_ALGORITHM_VERSION}:{clip_id}:{normalized}"
    digest = hashlib.sha256(key.encode()).hexdigest()
    return digest[:HASH_PREFIX_LEN]


def read_job(
    clip_id: str,
    cache_root: Path | None = None,
    *,
    timeout_seconds: float = DEFAULT_JOB_TIMEOUT_SECONDS,
) -> JobRecord | None:
    """Load the job status record for a clip if it exists, auto-expiring stalled jobs."""
    path = job_file(clip_id, cache_root)
    if not path.exists():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None

    status: JobStatus = raw.get("status", "running")
    stage: JobStage = raw.get("stage", "listening")
    mtime = path.stat().st_mtime
    updated_at = float(raw.get("updated_at", mtime))

    if status in ("running", "queued") and (time.time() - updated_at) > timeout_seconds:
        LOGGER.warning(
            "job %s stalled in stage %s for %.1fs (limit %.1fs); expiring to error",
            clip_id,
            stage,
            time.time() - updated_at,
            timeout_seconds,
        )
        expired_record: JobRecord = {
            "id": str(raw["id"]),
            "status": "error",
            "stage": "error",
            "trackmap_url": str(raw["trackmap_url"]),
            "isolation_id": raw.get("isolation_id"),
            "cached": False,
            "error": "Operation timed out. Please try again.",
            "updated_at": time.time(),
        }
        write_job(expired_record, cache_root)
        return expired_record

    return {
        "id": str(raw["id"]),
        "status": status,
        "stage": stage,
        "trackmap_url": str(raw["trackmap_url"]),
        "isolation_id": raw.get("isolation_id"),
        "cached": bool(raw.get("cached", False)),
        "error": raw.get("error"),
        "updated_at": updated_at,
    }


def write_job(record: JobRecord, cache_root: Path | None = None) -> JobRecord:
    """Atomically write a job status record."""
    if "updated_at" not in record:
        record["updated_at"] = time.time()
    path = job_file(record["id"], cache_root)
    tmp_path = path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(record), encoding="utf-8")
    tmp_path.replace(path)
    return record


def _quota_file(cache_root: Path) -> Path:
    day = time.strftime("%Y-%m-%d", time.gmtime())
    quotas_dir = cache_root / "quotas"
    quotas_dir.mkdir(parents=True, exist_ok=True)
    return quotas_dir / f"{day}.json"


def _load_quotas(cache_root: Path) -> dict[str, IpQuotaCounter]:
    path = _quota_file(cache_root)
    if not path.exists():
        return {}
    raw = json.loads(path.read_text(encoding="utf-8"))
    result: dict[str, IpQuotaCounter] = {}
    for ip, counts in raw.items():
        result[str(ip)] = {
            "clips": int(counts.get("clips", 0)),
            "isolations": int(counts.get("isolations", 0)),
        }
    return result


def _save_quotas(cache_root: Path, quotas: dict[str, IpQuotaCounter]) -> None:
    path = _quota_file(cache_root)
    tmp_path = path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(quotas), encoding="utf-8")
    tmp_path.replace(path)


def check_and_increment_quota(
    client_ip: str, kind: Literal["clips", "isolations"], cache_root: Path
) -> None:
    """Enforce per-IP daily limits and record usage."""
    if os.environ.get(DISABLE_QUOTA_ENV) == "1":
        return
    clip_limit = int(os.environ.get(CLIP_QUOTA_ENV, str(DAILY_CLIP_QUOTA)))
    isolation_limit = int(os.environ.get(ISOLATION_QUOTA_ENV, str(DAILY_ISOLATION_QUOTA)))
    quotas = _load_quotas(cache_root)
    counter = quotas.get(client_ip, {"clips": 0, "isolations": 0})
    limit = clip_limit if kind == "clips" else isolation_limit
    if counter[kind] >= limit:
        raise QuotaExceededError(f"Daily {kind} limit ({limit}) reached for this IP.")
    counter[kind] += 1
    quotas[client_ip] = counter
    _save_quotas(cache_root, quotas)


def probe_media(path: Path) -> MediaProbe:
    """Inspect duration and stream types using ffprobe."""
    argv = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(argv, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise IngestError("Could not decode media file.")
    payload = json.loads(completed.stdout or "{}")
    streams = payload.get("streams", [])
    has_audio = any(s.get("codec_type") == "audio" for s in streams)
    if not has_audio:
        raise IngestError("Media file contains no audio track.")
    video_streams = [s for s in streams if s.get("codec_type") == "video"]
    duration_str = payload.get("format", {}).get("duration")
    if duration_str is None:
        raise IngestError("Could not determine media duration.")
    duration = float(duration_str)
    width = int(video_streams[0].get("width", 0)) if video_streams else 0
    height = int(video_streams[0].get("height", 0)) if video_streams else 0
    return {
        "duration": duration,
        "has_video": bool(video_streams),
        "width": width,
        "height": height,
    }


def compute_wav_peaks(wav_path: Path, count: int = PEAKS_COUNT) -> list[float]:
    """Compute normalized peak amplitudes in [0, 1] across `count` buckets."""
    with wave.open(str(wav_path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        frames = wav_file.getnframes()
        raw = wav_file.readframes(frames)
    total_samples = frames * channels
    if total_samples == 0:
        return [0.0] * count
    samples = struct.unpack(f"<{total_samples}h", raw)
    step = max(1, total_samples // count)
    peaks: list[float] = []
    for idx in range(count):
        start = idx * step
        end = min(total_samples, start + step)
        chunk = samples[start:end]
        peak = max((abs(val) for val in chunk), default=0) / 32768.0
        peaks.append(round(min(1.0, peak), 3))
    return peaks


def _compute_energy_curve(wav_path: Path, duration: float) -> list[float]:
    buckets = max(1, math.ceil(duration / ENERGY_HOP_SECONDS))
    raw_peaks = compute_wav_peaks(wav_path, count=buckets)
    max_peak = max(raw_peaks, default=1.0)
    scale = max_peak if max_peak > 0.0 else 1.0
    return [round(min(1.0, val / scale), 3) for val in raw_peaks]


def _build_initial_trackmap(meta: ClipMeta, wav_path: Path, probe: MediaProbe) -> dict[str, object]:
    duration = round(meta["duration"], 3)
    beat_step = SECONDS_PER_MINUTE / DEFAULT_BPM
    beat_count = max(1, int(duration / beat_step))
    beats = [round(idx * beat_step, 3) for idx in range(beat_count)]
    downbeats = [beats[idx] for idx in range(0, len(beats), BEATS_PER_BAR)]
    chords = [
        {
            "bar": bar_idx,
            "start": start,
            "end": round(min(duration, start + beat_step * BEATS_PER_BAR), 3),
            "label": "Am",
            "root_midi": 57,
        }
        for bar_idx, start in enumerate(downbeats)
    ]
    trackmap: dict[str, object] = {
        "version": 2,
        "id": meta["id"],
        "source": {
            "kind": meta["kind"],
            "title": meta["title"],
            "license": "owned",
            "clip_start": meta["clip_start"],
            "clip_end": meta["clip_end"],
            "mix_url": f"/files/clips/{meta['id']}/mix.mp3",
        },
        "duration": duration,
        "tempo": {"bpm": DEFAULT_BPM, "time_signature": [4, 4], "confidence": 0.5},
        "beats": beats,
        "downbeats": downbeats,
        "key": {"tonic": "A", "mode": "minor", "confidence": 0.5},
        "chords": chords,
        "sections": [{"start": 0.0, "end": duration, "label": "section"}],
        "energy": {
            "hop": ENERGY_HOP_SECONDS,
            "values": _compute_energy_curve(wav_path, duration),
        },
        "suggestions": [
            {"label": "Synth lead", "prompt": "synth lead"},
            {"label": "Piano", "prompt": "piano"},
            {"label": "Bass", "prompt": "bass"},
            {"label": "Drums", "prompt": "drums"},
        ],
        "isolations": [],
    }
    if meta["kind"] == "video":
        scale = min(1.0, 720.0 / max(1, probe["height"]))
        width = max(2, round(probe["width"] * scale / 2.0) * 2)
        height = max(2, round(probe["height"] * scale / 2.0) * 2)
        trackmap["video"] = {
            "url": f"/files/clips/{meta['id']}/video.mp4",
            "fps": VIDEO_FPS,
            "width": width,
            "height": height,
            "tracks": [],
        }
    return trackmap


def _decode_trimmed_audio(
    src_path: Path, dst_stereo: Path, dst_mono: Path, start: float, duration: float
) -> None:
    stereo_argv = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        str(src_path),
        "-vn",
        "-ar",
        str(CANONICAL_SAMPLE_RATE),
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        str(dst_stereo),
    ]
    mono_argv = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        str(dst_stereo),
        "-ar",
        str(CANONICAL_SAMPLE_RATE),
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        str(dst_mono),
    ]
    subprocess.run(stereo_argv, check=True)
    subprocess.run(mono_argv, check=True)


def encode_mp3(wav_path: Path, mp3_path: Path) -> None:
    """Encode a WAV file to MP3 for fast browser playback."""
    argv = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        str(wav_path),
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        str(mp3_path),
    ]
    subprocess.run(argv, check=True)


def _extract_video_assets(src_path: Path, target_dir: Path, start: float, duration: float) -> None:
    video_out = target_dir / "video.mp4"
    frames_dir = target_dir / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)
    copy_argv = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-ss",
        f"{start:.3f}",
        "-t",
        f"{duration:.3f}",
        "-i",
        str(src_path),
        "-vf",
        "scale=-2:'min(720,ih)'",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "23",
        "-c:a",
        "aac",
        str(video_out),
    ]
    frames_argv = [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        str(video_out),
        "-vf",
        f"fps={VIDEO_FPS}",
        "-frames:v",
        str(MAX_VIDEO_FRAMES),
        str(frames_dir / "frame_%04d.jpg"),
    ]
    subprocess.run(copy_argv, check=True)
    subprocess.run(frames_argv, check=True)


def _validate_clip_window(
    clip_start: float, clip_end: float | None, source_duration: float
) -> tuple[float, float, float]:
    if clip_start < 0.0 or clip_start >= source_duration:
        raise IngestError("clip_start must be within the media duration.")
    resolved_end = (
        min(source_duration, clip_start + MAX_CLIP_DURATION_SECONDS)
        if clip_end is None
        else min(source_duration, clip_end)
    )
    duration = round(resolved_end - clip_start, 3)
    if duration < MIN_CLIP_DURATION_SECONDS:
        raise IngestError("Clip duration must be at least 0.5 seconds.")
    if duration > MAX_CLIP_DURATION_SECONDS:
        raise IngestError("Clip duration cannot exceed 30 seconds.")
    return round(clip_start, 3), round(resolved_end, 3), duration


def ingest_upload(params: IngestParams, cache_root: Path | None = None) -> JobRecord:
    """Validate, decode, hash, and persist an uploaded audio or video clip."""
    root = cache_root if cache_root is not None else get_cache_root()
    ext = Path(params["filename"]).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise IngestError("Unsupported file type. Upload MP3, WAV, MP4, MOV, or WebM.")
    if len(params["payload"]) == 0:
        raise IngestError("Uploaded file is empty.")
    if len(params["payload"]) > MAX_UPLOAD_BYTES:
        raise IngestError("File exceeds the 50 MB limit.", status_code=413)

    with tempfile.TemporaryDirectory() as tmp_str:
        tmp_dir = Path(tmp_str)
        src_path = tmp_dir / f"upload{ext}"
        src_path.write_bytes(params["payload"])
        probe = probe_media(src_path)
        if probe["duration"] > MAX_SOURCE_DURATION_SECONDS:
            raise IngestError("File exceeds the 6-minute duration limit.")

        start, end, duration = _validate_clip_window(
            params["clip_start"], params["clip_end"], probe["duration"]
        )
        stereo_wav = tmp_dir / "mix.wav"
        mono_wav = tmp_dir / "mix_mono.wav"
        _decode_trimmed_audio(src_path, stereo_wav, mono_wav, start, duration)
        clip_id = hashlib.sha256(stereo_wav.read_bytes()).hexdigest()

        target = clip_dir(clip_id, root)
        if (target / "trackmap.json").exists():
            existing = read_job(clip_id, root)
            if existing is not None:
                existing["cached"] = True
                return existing

        check_and_increment_quota(params["client_ip"], "clips", root)
        target.mkdir(parents=True, exist_ok=True)
        shutil.copy2(stereo_wav, target / "mix.wav")
        shutil.copy2(mono_wav, target / "mix_mono.wav")
        encode_mp3(target / "mix.wav", target / "mix.mp3")

        kind: SourceKind = "video" if (ext in VIDEO_EXTENSIONS and probe["has_video"]) else "audio"
        if kind == "video":
            _extract_video_assets(src_path, target, start, duration)

        title = (params["title"] or Path(params["filename"]).stem or "Untitled clip").strip()
        meta: ClipMeta = {
            "id": clip_id,
            "kind": kind,
            "title": title,
            "clip_start": start,
            "clip_end": end,
            "duration": duration,
            "created_at": time.time(),
        }
        (target / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
        trackmap = _build_initial_trackmap(meta, target / "mix_mono.wav", probe)
        write_trackmap(clip_id, trackmap, root)

    job: JobRecord = {
        "id": clip_id,
        "status": "done",
        "stage": "done",
        "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
        "isolation_id": None,
        "cached": False,
        "error": None,
        "updated_at": time.time(),
    }
    return write_job(job, root)


def trackmap_path(clip_id: str, cache_root: Path | None = None) -> Path:
    root = cache_root if cache_root is not None else get_cache_root()
    return clip_dir(clip_id, root) / "trackmap.json"


def write_trackmap(
    clip_id: str, trackmap: dict[str, object], cache_root: Path | None = None
) -> None:
    """Replace a clip's trackmap in one step, so a reader never sees a half-written file."""
    path = trackmap_path(clip_id, cache_root)
    tmp_path = path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(trackmap), encoding="utf-8")
    tmp_path.replace(path)


def _read_json_object(path: Path) -> dict[str, object]:
    """Read one JSON object from a cache artifact."""
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, dict) or not all(isinstance(key, str) for key in loaded):
        raise ValueError(f"expected JSON object at {path}")
    return {key: value for key, value in loaded.items() if isinstance(key, str)}


def _read_optional_json_object(path: Path) -> dict[str, object] | None:
    """Read an optional JSON object sidecar."""
    if not path.exists():
        return None
    return _read_json_object(path)


def _read_optional_json_array(path: Path) -> list[object] | None:
    """Read an optional JSON array sidecar."""
    if not path.exists():
        return None
    loaded = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(loaded, list):
        raise ValueError(f"expected JSON array at {path}")
    return loaded


SUGGEST_FIELDS = ("suggestions", "summary")


def _overlay_sidecar(trackmap: dict[str, object], path: Path, fields: tuple[str, ...]) -> None:
    """Copy the fields a producer owns onto the trackmap, if that producer has written yet."""
    sidecar = _read_optional_json_object(path)
    if sidecar is None:
        return
    for field in fields:
        if field in sidecar:
            trackmap[field] = sidecar[field]


def build_served_trackmap(clip_id: str, cache_root: Path | None = None) -> dict[str, object]:
    """Assemble a TrackMap from its ingest-time base and producer-owned sidecars."""
    root = cache_root if cache_root is not None else get_cache_root()
    directory = clip_dir(clip_id, root)
    trackmap = _read_json_object(trackmap_path(clip_id, root))

    _overlay_sidecar(trackmap, directory / "analysis.json", ANALYSIS_FIELDS)
    _overlay_sidecar(trackmap, directory / "suggest.json", SUGGEST_FIELDS)

    video = trackmap.get("video")
    tracks = _served_video_tracks(clip_id, directory)
    if isinstance(video, dict):
        video["tracks"] = tracks
    elif tracks:
        trackmap["video"] = {
            "url": f"/files/clips/{clip_id}/video.mp4",
            "fps": VIDEO_FPS,
            "width": 1280,
            "height": 720,
            "tracks": tracks,
        }

    fallback_stems = _read_optional_json_array(directory / "fallback_stems.json")
    if fallback_stems is not None:
        trackmap["fallback_stems"] = fallback_stems

    isolations_dir = directory / "isolations"
    isolations: list[dict[str, object]] = []
    if isolations_dir.exists():
        for isolation_dir in sorted(isolations_dir.iterdir(), key=lambda item: item.name):
            if not isolation_dir.is_dir():
                continue
            isolation = _read_optional_json_object(isolation_dir / "isolation.json")
            if isolation is None:
                continue
            transcription = _read_optional_json_object(isolation_dir / "transcription.json")
            if transcription is not None:
                for field in TRANSCRIPTION_FIELDS:
                    if field in transcription:
                        isolation[field] = transcription[field]
            # Each of these is written by its own producer, arrives after the sound and its notes,
            # and is allowed to be missing: a clip without a recipe or a summary still serves.
            for filename, field in ISOLATION_SIDECARS:
                extra = _read_optional_json_object(isolation_dir / filename)
                if extra is not None:
                    isolation[field] = extra.get(field, extra)
            isolations.append(isolation)
    trackmap["isolations"] = isolations
    return trackmap


def _served_video_tracks(clip_id: str, directory: Path) -> list[dict[str, object]]:
    """Expose each tracking sidecar as a schema-compatible video track on read."""
    tracks_dir = directory / "tracks"
    if not tracks_dir.exists():
        return []

    tracks: list[dict[str, object]] = []
    for path in sorted(tracks_dir.glob("*.json")):
        track = _read_optional_json_object(path)
        if track is None:
            continue
        track_id = track.get("id")
        label = track.get("label")
        visible = track.get("visible")
        if (
            not isinstance(track_id, str)
            or not isinstance(label, str)
            or not isinstance(visible, list)
        ):
            continue
        served: dict[str, object] = {
            "id": track_id,
            "label": label,
            "masks_url": f"/files/clips/{clip_id}/tracks/{path.name}",
            "visible": visible,
        }
        prompt = track.get("prompt")
        if isinstance(prompt, str):
            served["prompt"] = prompt
        isolation_id = track.get("isolation_id")
        if isinstance(isolation_id, str):
            served["isolation_id"] = isolation_id
        tracks.append(served)
    return tracks


def cleanup_expired_clips(
    cache_root: Path | None = None, max_age_seconds: int = RETENTION_SECONDS
) -> int:
    """Delete cached clips and job files older than `max_age_seconds` (default 7 days)."""
    root = cache_root if cache_root is not None else get_cache_root()
    clips_root = root / "clips"
    if not clips_root.exists():
        return 0
    cutoff = time.time() - max_age_seconds
    removed = 0
    for directory in clips_root.iterdir():
        if not directory.is_dir():
            continue
        meta_path = directory / "meta.json"
        mtime = directory.stat().st_mtime
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
                mtime = float(meta.get("created_at", mtime))
            except (ValueError, KeyError):
                pass
        if mtime < cutoff:
            shutil.rmtree(directory, ignore_errors=True)
            job_path = root / "jobs" / f"{directory.name}.json"
            job_path.unlink(missing_ok=True)
            removed += 1
    LOGGER.info("cleaned up %d expired clips", removed)
    return removed
