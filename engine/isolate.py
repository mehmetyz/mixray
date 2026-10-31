"""SAM Audio: pull one named sound out of a clip and leave everything else behind.

`run_isolation` separates a named sound from a cached clip; `run_visual_isolation` does the same
for a sound the user pointed at in the video, using the name the tap resolved to.
"""

import logging
import subprocess
import time
import wave
from pathlib import Path
from typing import TYPE_CHECKING

import modal

from ingest import (
    IsolationEntry,
    IsolationMethod,
    JobRecord,
    clip_dir,
    compute_wav_peaks,
    encode_mp3,
    get_cache_root,
    write_job,
)

if TYPE_CHECKING:
    import torch
    from sam_audio import Batch, SAMAudio, SAMAudioProcessor

    from track import TrackResult

LOGGER = logging.getLogger(__name__)


WEIGHTS_VOLUME = modal.Volume.from_name("mixray-weights", create_if_missing=True)
WEIGHTS_PATH = "/weights"
HF_SECRET = modal.Secret.from_name("mixray-hf")
# A list is a fallback order: Modal takes the first type with free capacity. L4 and A10G both
# have the 24 GB this model needs, so waiting for a specific one only adds queue time.
ISOLATION_GPU = ["L4", "A10G"]

DEFAULT_MODEL_ID = "facebook/sam-audio-small"

# Passing the rankers and span predictor as None keeps ImageBind (~4.5 GB), CLAP (~1.9 GB), Judge,
# and PE-A-Frame from being built or downloaded. They are only used when reranking_candidates > 1
# or predict_spans=True. Do NOT pass `strict=False`: `SAMAudio.load_state_dict`
# (`sam_audio/model/model.py` line 359) has `if strict:` with no `else:` branch, so `strict=False`
# silently skips loading `checkpoint.pt` and leaves the entire model randomly initialized. With the
# default `strict=True`, `SAMAudio.load_state_dict` loads `checkpoint.pt` via
# `super().load_state_dict(..., strict=False)` and filters the rankers out of `missing_keys`.
RANKERS_OFF = {"visual_ranker": None, "text_ranker": None, "span_predictor": None}


def _save_pcm16_wav(path: Path, waveform: "torch.Tensor", sample_rate: int) -> None:
    """16-bit PCM by hand: torchaudio's backends are not reliable inside this image."""
    import torch

    tensor = waveform.unsqueeze(0) if waveform.ndim == 1 else waveform
    pcm = (
        (tensor.clamp(-1.0, 1.0) * 32767.0)
        .to(torch.int16)
        .transpose(0, 1)
        .contiguous()
        .numpy()
        .tobytes()
    )
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(int(tensor.shape[0]))
        wav_file.setsampwidth(2)
        wav_file.setframerate(int(sample_rate))
        wav_file.writeframes(pcm)


def _rms(waveform: "torch.Tensor") -> float:
    return float(waveform.pow(2).mean().sqrt())


def _cached_isolation(
    clip_id: str, iso_id: str, cache_root: Path
) -> tuple[Path, Path, str, IsolationEntry | None]:
    """Return the isolation cache paths and restore the job when its entry already exists."""
    import json

    iso_dir = clip_dir(clip_id, cache_root) / "isolations" / iso_id
    cached_json = iso_dir / "isolation.json"
    trackmap_url = f"/files/clips/{clip_id}/trackmap.json"
    if not cached_json.exists():
        return iso_dir, cached_json, trackmap_url, None

    entry: IsolationEntry = json.loads(cached_json.read_text(encoding="utf-8"))
    write_job(
        {
            "id": clip_id,
            "status": "done",
            "stage": "done",
            "trackmap_url": trackmap_url,
            "isolation_id": iso_id,
            "cached": True,
            "error": None,
            "updated_at": time.time(),
        },
        cache_root,
    )
    return iso_dir, cached_json, trackmap_url, entry


# The arguments are one cohesive act of persistence and every heavy one is keyword-only, so
# naming them beats bundling them into a record that exists only to satisfy the count.
def _persist_isolation(  # noqa: PLR0913
    clip_id: str,
    iso_id: str,
    *,
    label: str,
    prompt: str,
    method: IsolationMethod,
    sound: "torch.Tensor",
    rest: "torch.Tensor",
    processor: "SAMAudioProcessor",
    cache_root: Path,
    iso_dir: Path,
    cached_json: Path,
    trackmap_url: str,
) -> IsolationEntry:
    """Write one completed SAM Audio result using the shared isolation sidecar format."""
    import json

    iso_dir.mkdir(parents=True, exist_ok=True)
    sample_rate = int(processor.audio_sampling_rate)
    sound_wav = iso_dir / "sound.wav"
    rest_wav = iso_dir / "rest.wav"
    _save_pcm16_wav(sound_wav, sound, sample_rate)
    _save_pcm16_wav(rest_wav, rest, sample_rate)
    encode_mp3(sound_wav, iso_dir / "sound.mp3")
    encode_mp3(rest_wav, iso_dir / "rest.mp3")

    write_job(
        {
            "id": clip_id,
            "status": "running",
            "stage": "analyzing",
            "trackmap_url": trackmap_url,
            "isolation_id": iso_id,
            "cached": False,
            "error": None,
            "updated_at": time.time(),
        },
        cache_root,
    )

    base_url = f"/files/clips/{clip_id}/isolations/{iso_id}"
    entry: IsolationEntry = {
        "id": iso_id,
        "label": label,
        "prompt": prompt,
        "method": method,
        "sound_url": f"{base_url}/sound.mp3",
        "sound_wav_url": f"{base_url}/sound.wav",
        "rest_url": f"{base_url}/rest.mp3",
        "peaks": compute_wav_peaks(sound_wav),
        "rest_peaks": compute_wav_peaks(rest_wav),
        "notes": [],
        "arrangements": {"easy": [], "intermediate": []},
    }
    tmp_path = cached_json.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(entry), encoding="utf-8")
    tmp_path.replace(cached_json)
    done_job: JobRecord = {
        "id": clip_id,
        "status": "done",
        "stage": "done",
        "trackmap_url": trackmap_url,
        "isolation_id": iso_id,
        "cached": False,
        "error": None,
        "updated_at": time.time(),
    }
    write_job(done_job, cache_root)
    return entry


def _separate_and_persist(  # noqa: PLR0913
    clip_id: str,
    iso_id: str,
    *,
    label: str,
    prompt: str,
    method: IsolationMethod,
    batch: "Batch",
    model: "SAMAudio",
    processor: "SAMAudioProcessor",
    cache_root: Path,
    iso_dir: Path,
    cached_json: Path,
    trackmap_url: str,
) -> IsolationEntry:
    """Run one prepared SAM Audio batch and persist its result."""
    import torch

    with torch.inference_mode():
        separation = model.separate(batch, predict_spans=False, reranking_candidates=1)

    target_item = separation.target[0] if isinstance(separation.target, list) else separation.target
    residual_item = (
        separation.residual[0] if isinstance(separation.residual, list) else separation.residual
    )
    sound = target_item.detach().float().cpu()
    rest = residual_item.detach().float().cpu()
    return _persist_isolation(
        clip_id,
        iso_id,
        label=label,
        prompt=prompt,
        method=method,
        sound=sound,
        rest=rest,
        processor=processor,
        cache_root=cache_root,
        iso_dir=iso_dir,
        cached_json=cached_json,
        trackmap_url=trackmap_url,
    )


# Keyword-only below the identifiers: a caller cannot swap the model for the processor, which
# is the mistake the argument count is a proxy for.
def run_isolation(  # noqa: PLR0913
    clip_id: str,
    iso_id: str,
    prompt: str,
    label: str,
    *,
    model: "SAMAudio",
    processor: "SAMAudioProcessor",
    cache_root: Path | None = None,
) -> IsolationEntry:
    """Separate `prompt` from `clip_id` with SAM Audio and persist sound, rest, and peaks."""
    root = cache_root if cache_root is not None else get_cache_root()
    iso_dir, cached_json, trackmap_url, cached = _cached_isolation(clip_id, iso_id, root)
    if cached is not None:
        return cached

    mix_wav = clip_dir(clip_id, root) / "mix.wav"
    batch = processor(audios=[str(mix_wav)], descriptions=[prompt]).to("cuda")
    return _separate_and_persist(
        clip_id,
        iso_id,
        label=label,
        prompt=prompt,
        method="sam_audio_text",
        batch=batch,
        model=model,
        processor=processor,
        cache_root=root,
        iso_dir=iso_dir,
        cached_json=cached_json,
        trackmap_url=trackmap_url,
    )


def _clip_video_size(directory: Path) -> tuple[int, int]:
    """Read the pixel dimensions used when SAM 3.1 received this clip."""
    import json

    metadata = json.loads((directory / "trackmap.json").read_text(encoding="utf-8"))
    if not isinstance(metadata, dict):
        raise RuntimeError("clip trackmap is not an object")
    video = metadata.get("video")
    if not isinstance(video, dict):
        raise RuntimeError("visual isolation requires a video clip")
    width, height = video.get("width"), video.get("height")
    if isinstance(width, bool) or not isinstance(width, int) or width <= 0:
        raise RuntimeError("clip video width is invalid")
    if isinstance(height, bool) or not isinstance(height, int) or height <= 0:
        raise RuntimeError("clip video height is invalid")
    return width, height


def _video_frames(video_path: Path, width: int, height: int) -> "torch.Tensor":
    """Decode the same 10 fps RGB frames that SAM 3.1 saw into uint8 NCHW form."""
    import torch

    completed = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(video_path),
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "pipe:1",
        ],
        check=True,
        capture_output=True,
    )
    frame_size = width * height * 3
    if not completed.stdout or len(completed.stdout) % frame_size != 0:
        raise RuntimeError("decoded video frames do not match the clip dimensions")
    return (
        torch.frombuffer(bytearray(completed.stdout), dtype=torch.uint8)
        .reshape(-1, height, width, 3)
        .permute(0, 3, 1, 2)
        .contiguous()
    )


# Same shape as `run_isolation`, deliberately: the two differ only in how the target is named.
def run_visual_isolation(  # noqa: PLR0913
    clip_id: str,
    iso_id: str,
    track: "TrackResult",
    *,
    model: "SAMAudio",
    processor: "SAMAudioProcessor",
    cache_root: Path | None = None,
) -> IsolationEntry:
    """Separate a tracked object with its SAM 3.1 raster mask as a SAM Audio visual prompt."""
    from track import track_mask_tensor

    root = cache_root if cache_root is not None else get_cache_root()
    iso_dir, cached_json, trackmap_url, cached = _cached_isolation(clip_id, iso_id, root)
    if cached is not None:
        return cached

    directory = clip_dir(clip_id, root)
    width, height = _clip_video_size(directory)
    segment_input = directory / "segment_input.mp4"
    if not segment_input.is_file():
        raise FileNotFoundError(f"clip {clip_id} has no segmented video: {segment_input}")
    frames = _video_frames(segment_input, width, height)
    masks = track_mask_tensor(track, int(frames.shape[0]), width, height)
    masked_videos = processor.mask_videos([frames], [masks])
    mix_wav = directory / "mix.wav"
    batch = processor(audios=[str(mix_wav)], descriptions=[""], masked_videos=masked_videos).to(
        "cuda"
    )
    return _separate_and_persist(
        clip_id,
        iso_id,
        label=track["label"],
        prompt=track["prompt"],
        method="sam_audio_visual",
        batch=batch,
        model=model,
        processor=processor,
        cache_root=root,
        iso_dir=iso_dir,
        cached_json=cached_json,
        trackmap_url=trackmap_url,
    )


# The README calls `predict_spans=True` with `reranking_candidates=8` "better results at the cost
# of latency and memory", and the subjective scores it publishes put `sam-audio-base` *below*
# `-small` on music (3.87 vs 4.11), so candidate reranking is the lever worth measuring, not model
# size. The ladder climbs so an out-of-memory failure at the top still leaves every cheaper rung
# measured: each candidate runs the ODE on its own copy of the clip.
QUALITY_LADDER: list[tuple[bool, int]] = [(False, 1), (True, 1), (True, 2), (True, 4), (True, 8)]


# Four performers in the test clip, as (label, text prompt, x, y, width, height) on a 448x252 frame:
# a violinist, a cellist, a pianist and a singer, each clearly separated in the picture. The boxes
# were checked against a rendered frame before use.
# (label, text prompt, x, y, width, height)
VisualTarget = tuple[str, str, int, int, int, int]
VISUAL_TARGETS: list[VisualTarget] = [
    ("violin", "violin", 7, 60, 60, 170),
    ("cello", "cello", 75, 85, 80, 125),
    ("piano", "piano", 180, 90, 70, 110),
    ("voice", "woman singing", 340, 60, 62, 175),
]
