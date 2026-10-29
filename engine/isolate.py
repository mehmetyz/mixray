"""SAM Audio: pull one named sound out of a clip and leave everything else behind.

`measure` answers the open question in TASKS.md T1.1 — what SAM Audio really costs in VRAM and
time, and whether the auxiliary ranker models can be left out. Run it with:

    uv run modal run isolate.py::measure
"""

import logging
import os
import subprocess
import time
import wave
from pathlib import Path
from typing import TYPE_CHECKING, TypedDict

import modal

from images import sam_audio_image
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

app = modal.App("mixray-isolate")

WEIGHTS_VOLUME = modal.Volume.from_name("mixray-weights", create_if_missing=True)
WEIGHTS_PATH = "/weights"
HF_SECRET = modal.Secret.from_name("mixray-hf")

MEASURE_TIMEOUT_SECONDS = 1800
# A list is a fallback order: Modal takes the first type with free capacity. L4 and A10G both
# have 24 GB, and A10G costs about 1.5 cents more on a three-minute run, so waiting for an L4
# in US peak hours is the worse trade.
MEASURE_GPU = ["L4", "A10G"]

DEFAULT_MODEL_ID = "facebook/sam-audio-small"
DEFAULT_PROMPT = "synth lead"
GIGABYTE = 1e9

#
#
SAMPLE_URL = (
    "https://example.invalid/"
    "sample.webm"
)
USER_AGENT = "mixray-benchmark/1.0 (hackathon research)"
CLIP_START_SECONDS = 480.0
CLIP_SECONDS = 30.0
CLIP_SAMPLE_RATE = 44_100

# Passing the rankers and span predictor as None keeps ImageBind (~4.5 GB), CLAP (~1.9 GB), Judge,
# and PE-A-Frame from being built or downloaded. They are only used when reranking_candidates > 1
# or predict_spans=True. Do NOT pass `strict=False`: `SAMAudio.load_state_dict`
# (`sam_audio/model/model.py` line 359) has `if strict:` with no `else:` branch, so `strict=False`
# silently skips loading `checkpoint.pt` and leaves the entire model randomly initialized. With the
# default `strict=True`, `SAMAudio.load_state_dict` loads `checkpoint.pt` via
# `super().load_state_dict(..., strict=False)` and filters the rankers out of `missing_keys`.
RANKERS_OFF = {"visual_ranker": None, "text_ranker": None, "span_predictor": None}


class ChildSize(TypedDict):
    """One top-level submodule of the loaded model, and what its weights weigh."""

    name: str
    gigabytes: float


class MeasureResult(TypedDict):
    """Everything one measurement run learned. `error` is empty when separation succeeded."""

    model_id: str
    prompt: str
    gpu: str
    gpu_total_gb: float
    load_seconds: float
    model_gb_as_loaded: float
    dtype_as_loaded: str
    children: list[ChildSize]
    gpu_gb_after_move: float
    separate_seconds: float
    peak_vram_gb: float
    mix_rms: float
    sound_rms: float
    rest_rms: float
    reconstruction_error: float
    finite: bool
    output_dir: str
    error: str


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


def _clip_argv(destination: str) -> list[str]:
    """ffmpeg seeks the remote webm over HTTP range requests, so only the clip is fetched."""
    return [
        "ffmpeg",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-user_agent",
        USER_AGENT,
        "-ss",
        str(CLIP_START_SECONDS),
        "-t",
        str(CLIP_SECONDS),
        "-i",
        SAMPLE_URL,
        "-ar",
        str(CLIP_SAMPLE_RATE),
        "-ac",
        "2",
        "-c:a",
        "pcm_s16le",
        destination,
    ]


def _child_sizes(sizes: list[tuple[str, float]]) -> list[ChildSize]:
    """Where the weights actually sit, so VRAM surprises can be traced to a submodule."""
    return [{"name": name, "gigabytes": round(size_gb, 3)} for name, size_gb in sizes]


def _rms(waveform: "torch.Tensor") -> float:
    return float(waveform.pow(2).mean().sqrt())


@app.function(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME},
    secrets=[HF_SECRET],
    timeout=MEASURE_TIMEOUT_SECONDS,
)
def measure(model_id: str = DEFAULT_MODEL_ID, prompt: str = DEFAULT_PROMPT) -> MeasureResult:
    # Set before the model libraries load, so weights land on the Volume and survive the container.
    os.environ["HF_HOME"] = f"{WEIGHTS_PATH}/huggingface"

    import torch
    from sam_audio import SAMAudio, SAMAudioProcessor

    logging.basicConfig(level=logging.INFO)

    output_dir = Path(WEIGHTS_PATH) / "measure"
    output_dir.mkdir(parents=True, exist_ok=True)
    clip = output_dir / "clip.wav"

    if not clip.exists():
        subprocess.run(_clip_argv(str(clip)), check=True)

    LOGGER.info("clip ready: %s", clip)

    def module_gb(module: torch.nn.Module) -> float:
        return float(sum(p.numel() * p.element_size() for p in module.parameters())) / GIGABYTE

    properties = torch.cuda.get_device_properties(0)

    # Load on the CPU first: an fp32 load straight to a 23 GB L4 dies at 20.8 GB, and we want to
    # see which submodule claims it rather than guess.
    started = time.perf_counter()
    model = SAMAudio.from_pretrained(model_id, **RANKERS_OFF)
    processor = SAMAudioProcessor.from_pretrained(model_id)
    load_seconds = time.perf_counter() - started

    children = _child_sizes([(name, module_gb(child)) for name, child in model.named_children()])

    result: MeasureResult = {
        "model_id": model_id,
        "prompt": prompt,
        "gpu": properties.name,
        "gpu_total_gb": round(properties.total_memory / GIGABYTE, 1),
        "load_seconds": round(load_seconds, 1),
        "model_gb_as_loaded": round(module_gb(model), 3),
        "dtype_as_loaded": str(next(model.parameters()).dtype),
        "children": children,
        "gpu_gb_after_move": 0.0,
        "separate_seconds": 0.0,
        "peak_vram_gb": 0.0,
        "mix_rms": 0.0,
        "sound_rms": 0.0,
        "rest_rms": 0.0,
        "reconstruction_error": 0.0,
        "finite": False,
        "output_dir": str(output_dir),
        "error": "",
    }

    # With the rankers off, fp32 fits a 24 GB card with room to spare (~5.6 GB of weights).
    model = model.eval().cuda()
    result["gpu_gb_after_move"] = round(torch.cuda.memory_allocated() / GIGABYTE, 3)
    LOGGER.info("on gpu in fp32: %.2f GB", result["gpu_gb_after_move"])

    batch = processor(audios=[str(clip)], descriptions=[prompt]).to("cuda")
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    try:
        with torch.inference_mode():
            separation = model.separate(batch, predict_spans=False, reranking_candidates=1)
    except Exception as error:  # reported to the caller instead of killing the measurement
        result["separate_seconds"] = round(time.perf_counter() - started, 1)
        result["error"] = f"{type(error).__name__}: {error}"
        LOGGER.error("separate failed: %s", result["error"])
        return result

    result["separate_seconds"] = round(time.perf_counter() - started, 1)
    result["peak_vram_gb"] = round(torch.cuda.max_memory_allocated() / GIGABYTE, 3)

    target_item = separation.target[0] if isinstance(separation.target, list) else separation.target
    residual_item = (
        separation.residual[0] if isinstance(separation.residual, list) else separation.residual
    )
    sound = target_item.detach().float().cpu()
    rest = residual_item.detach().float().cpu()
    mix = batch.audios.detach().float().flatten().cpu()[: sound.numel()]
    mix_rms = _rms(mix)

    result.update(
        {
            "mix_rms": round(mix_rms, 5),
            "sound_rms": round(_rms(sound), 5),
            "rest_rms": round(_rms(rest), 5),
            "reconstruction_error": round(
                _rms(mix - (sound.flatten() + rest.flatten())) / max(mix_rms, 1e-9), 5
            ),
            "finite": bool(torch.isfinite(sound).all() and torch.isfinite(rest).all()),
        }
    )
    LOGGER.info(
        "separated in %.1fs, peak %.2f GB: %s",
        result["separate_seconds"],
        result["peak_vram_gb"],
        result,
    )

    try:
        stem = f"{model_id.rsplit('/', 1)[-1]}__{prompt.replace(' ', '_')}"
        sample_rate = int(processor.audio_sampling_rate)
        _save_pcm16_wav(output_dir / f"{stem}__sound.wav", sound, sample_rate)
        _save_pcm16_wav(output_dir / f"{stem}__rest.wav", rest, sample_rate)
        WEIGHTS_VOLUME.commit()
    except Exception as error:
        result["error"] = f"save_failed: {type(error).__name__}: {error}"
        LOGGER.error("saving wav failed: %s", result["error"])

    return result


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


# The clip is dub techno with an ambient field recording mixed in: kick, hats, chord stabs, bass and
# room noise. There is no lead, so asking for "synth lead" made the model hand back the noisiest
# thing it could find — its isolated output crosses zero three times as often as the mix does.
# These prompts match what is actually playing. "room ambience" is the control: if that one comes
# out clean, the model works and the prompt was the whole problem.
SWEEP_PROMPTS = ["kick drum", "hi-hat", "synth chord", "bass", "room ambience"]


@app.function(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME},
    secrets=[HF_SECRET],
    timeout=MEASURE_TIMEOUT_SECONDS,
)
def sweep(model_id: str = DEFAULT_MODEL_ID) -> str:
    """Separate one clip with several prompts and save every result for listening.

    `rest/mix` close to 1.0 means the residual kept the music, which is what a good split looks
    like when the target is one part of it. `recon` is how well target + residual rebuild the mix.
    """
    os.environ["HF_HOME"] = f"{WEIGHTS_PATH}/huggingface"

    import torch
    from sam_audio import SAMAudio, SAMAudioProcessor

    logging.basicConfig(level=logging.INFO)
    lines: list[str] = []

    def say(text: str) -> None:
        lines.append(text)
        LOGGER.info(text)

    model = SAMAudio.from_pretrained(model_id, **RANKERS_OFF).eval().cuda()
    processor = SAMAudioProcessor.from_pretrained(model_id)
    sample_rate = int(processor.audio_sampling_rate)
    output_dir = Path(WEIGHTS_PATH) / "measure"
    clip = str(output_dir / "clip.wav")

    say(f"{'prompt':16} {'secs':>5} {'target':>8} {'rest':>8} {'rest/mix':>9} {'recon':>7}")
    for prompt in SWEEP_PROMPTS:
        batch = processor(audios=[clip], descriptions=[prompt]).to("cuda")
        started = time.perf_counter()
        with torch.inference_mode():
            separation = model.separate(batch, predict_spans=False, reranking_candidates=1)
        elapsed = time.perf_counter() - started

        mix = batch.audios.detach().float().flatten().cpu()
        target = separation.target[0].detach().float().cpu()
        residual = separation.residual[0].detach().float().cpu()
        mix_rms = max(_rms(mix), 1e-9)
        recon = _rms(mix - (target + residual)) / mix_rms

        stem = prompt.replace(" ", "_")
        _save_pcm16_wav(output_dir / f"{stem}__sound.wav", target, sample_rate)
        _save_pcm16_wav(output_dir / f"{stem}__rest.wav", residual, sample_rate)
        say(
            f"{prompt:16} {elapsed:5.1f} {_rms(target):8.5f} {_rms(residual):8.5f} "
            f"{_rms(residual) / mix_rms:9.2f} {recon:7.3f}"
        )

    WEIGHTS_VOLUME.commit()
    say(f"wrote {2 * len(SWEEP_PROMPTS)} files to {output_dir}")
    return "\n".join(lines)


QUALITY_PROMPT = "synth chord"
# The README calls `predict_spans=True` with `reranking_candidates=8` "better results at the cost
# of latency and memory", and the subjective scores it publishes put `sam-audio-base` *below*
# `-small` on music (3.87 vs 4.11), so candidate reranking is the lever worth measuring, not model
# size. The ladder climbs so an out-of-memory failure at the top still leaves every cheaper rung
# measured: each candidate runs the ODE on its own copy of the clip.
QUALITY_LADDER: list[tuple[bool, int]] = [(False, 1), (True, 1), (True, 2), (True, 4), (True, 8)]


def _quality_load_kwargs() -> dict[str, object]:
    """Load options for the quality ladder, as a fresh dict per call.

    `reranking_candidates > 1` scores candidates with `text_ranker` for text prompts and with
    `visual_ranker` only when a masked video is present (`sam_audio/model/model.py` lines 319-334),
    so CLAP is the only ranker this needs and ImageBind never has to be importable. The released
    config leaves `text_ranker` at None (`sam_audio/model/config.py` line 215), which makes
    reranking a silent no-op until it is passed in. `span_predictor` keeps its default so
    `predict_spans=True` has something to call. The dict is rebuilt every call because
    `parse_ranker_config` pops `kind` out of the mapping it is handed.
    """
    return {"visual_ranker": None, "text_ranker": {"kind": "clap"}}


class QualityTrial(TypedDict):
    """One rung of the quality ladder. `error` is empty when the separation finished."""

    predict_spans: bool
    candidates: int
    seconds: float
    peak_vram_gb: float
    sound_rms: float
    rest_rms: float
    reconstruction_error: float
    error: str


class RerankCandidate(TypedDict):
    """Measurements and CLAP score for one sequentially drawn candidate."""

    index: int
    seconds: float
    peak_vram_gb: float
    target_rms: float
    rest_rms: float
    reconstruction_error: float
    clap_score: float


def _quality_trial(
    model: "SAMAudio",
    batch: "Batch",
    predict_spans: bool,
    candidates: int,
) -> tuple[QualityTrial, "torch.Tensor | None", "torch.Tensor | None"]:
    """Run one rung and measure it.

    A rung too big for the card reports the error instead of raising, so the ladder continues.
    """
    import torch

    trial: QualityTrial = {
        "predict_spans": predict_spans,
        "candidates": candidates,
        "seconds": 0.0,
        "peak_vram_gb": 0.0,
        "sound_rms": 0.0,
        "rest_rms": 0.0,
        "reconstruction_error": 0.0,
        "error": "",
    }
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    try:
        with torch.inference_mode():
            separation = model.separate(
                batch, predict_spans=predict_spans, reranking_candidates=candidates
            )
    except Exception as error:  # a rung that does not fit must not end the ladder
        trial["seconds"] = round(time.perf_counter() - started, 1)
        trial["error"] = f"{type(error).__name__}: {error}"
        torch.cuda.empty_cache()
        return trial, None, None

    trial["seconds"] = round(time.perf_counter() - started, 1)
    trial["peak_vram_gb"] = round(torch.cuda.max_memory_allocated() / GIGABYTE, 3)

    mix = batch.audios.detach().float().flatten().cpu()
    target = separation.target[0].detach().float().cpu()
    residual = separation.residual[0].detach().float().cpu()
    mix_rms = max(_rms(mix), 1e-9)
    trial["sound_rms"] = round(_rms(target), 5)
    trial["rest_rms"] = round(_rms(residual), 5)
    trial["reconstruction_error"] = round(_rms(mix - (target + residual)) / mix_rms, 5)
    return trial, target, residual


def _quality_row(trial: QualityTrial) -> str:
    if trial["error"]:
        return (
            f"{trial['predict_spans']!s:>5} {trial['candidates']:>2} "
            f"{trial['seconds']:6.1f} FAILED {trial['error'][:70]}"
        )
    return (
        f"{trial['predict_spans']!s:>5} {trial['candidates']:>2} {trial['seconds']:6.1f} "
        f"{trial['peak_vram_gb']:7.2f} {trial['sound_rms']:8.5f} "
        f"{trial['rest_rms']:8.5f} {trial['reconstruction_error']:7.3f}"
    )


def _rerank_row(candidate: RerankCandidate) -> str:
    """Format one sequential candidate for the benchmark report."""
    return (
        f"{candidate['index']:>4} {candidate['seconds']:6.1f} "
        f"{candidate['peak_vram_gb']:7.2f} {candidate['target_rms']:8.5f} "
        f"{candidate['rest_rms']:8.5f} {candidate['reconstruction_error']:7.3f} "
        f"{candidate['clap_score']:8.5f}"
    )


def _draw_rerank_candidate(
    model: "SAMAudio",
    processor: "SAMAudioProcessor",
    clip: Path,
    prompt: str,
    index: int,
) -> tuple[RerankCandidate, "torch.Tensor", "torch.Tensor"]:
    """Draw one candidate and return CPU audio so GPU memory stays flat between draws."""
    import torch

    batch = processor(audios=[str(clip)], descriptions=[prompt]).to("cuda")
    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    with torch.inference_mode():
        separation = model.separate(batch, predict_spans=True, reranking_candidates=1)
    elapsed = time.perf_counter() - started
    peak_vram_gb = torch.cuda.max_memory_allocated() / GIGABYTE

    target_item = separation.target[0] if isinstance(separation.target, list) else separation.target
    residual_item = (
        separation.residual[0] if isinstance(separation.residual, list) else separation.residual
    )
    target = target_item.detach().float().cpu()
    residual = residual_item.detach().float().cpu()
    mix = batch.audios.detach().float().flatten().cpu()
    mix_rms = max(_rms(mix), 1e-9)
    result: RerankCandidate = {
        "index": index,
        "seconds": round(elapsed, 1),
        "peak_vram_gb": round(peak_vram_gb, 3),
        "target_rms": round(_rms(target), 5),
        "rest_rms": round(_rms(residual), 5),
        "reconstruction_error": round(_rms(mix - (target + residual)) / mix_rms, 5),
        "clap_score": 0.0,
    }
    del separation, target_item, residual_item, batch
    torch.cuda.empty_cache()
    return result, target, residual


def _score_rerank_candidates(
    model: "SAMAudio",
    prompt: str,
    sample_rate: int,
    targets: list["torch.Tensor"],
    results: list[RerankCandidate],
) -> tuple[RerankCandidate, RerankCandidate]:
    """Score all CPU candidates in one CLAP call and return the best and worst results."""
    import torch

    stacked_targets = torch.stack(targets).to("cuda")
    with torch.inference_mode():
        scores = model.text_ranker(
            extracted_audio=[stacked_targets], descriptions=[prompt], sample_rate=sample_rate
        )
    score_values = scores[0].detach().float().cpu()
    for result, score in zip(results, score_values, strict=True):
        result["clap_score"] = float(score)
    return (
        max(results, key=lambda result: result["clap_score"]),
        min(results, key=lambda result: result["clap_score"]),
    )


@app.function(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME},
    secrets=[HF_SECRET],
    timeout=MEASURE_TIMEOUT_SECONDS,
)
def quality(model_id: str = DEFAULT_MODEL_ID, prompt: str = QUALITY_PROMPT) -> str:
    """Separate one clip at rising candidate counts and report cost and output per rung.

    Answers whether span prediction and candidate reranking are worth their latency, and how many
    candidates a 24 GB card can hold. Every rung writes its own pair of WAVs for A/B listening.
    """
    os.environ["HF_HOME"] = f"{WEIGHTS_PATH}/huggingface"

    import torch
    from sam_audio import SAMAudio, SAMAudioProcessor

    logging.basicConfig(level=logging.INFO)
    lines: list[str] = []

    def say(text: str) -> None:
        lines.append(text)
        LOGGER.info(text)

    output_dir = Path(WEIGHTS_PATH) / "measure"
    output_dir.mkdir(parents=True, exist_ok=True)
    clip = output_dir / "clip.wav"
    if not clip.exists():
        subprocess.run(_clip_argv(str(clip)), check=True)

    properties = torch.cuda.get_device_properties(0)
    started = time.perf_counter()
    model = SAMAudio.from_pretrained(model_id, **_quality_load_kwargs()).eval().cuda()
    processor = SAMAudioProcessor.from_pretrained(model_id)
    sample_rate = int(processor.audio_sampling_rate)
    stem = model_id.rsplit("/", 1)[-1]

    say(f"{stem} on {properties.name} ({properties.total_memory / GIGABYTE:.1f} GB)")
    load_seconds = time.perf_counter() - started
    say(f"loaded clap text_ranker and the default span predictor in {load_seconds:.1f}s")
    say(f"prompt: {prompt!r}")
    say(f"{'spans':>5} {'k':>2} {'secs':>6} {'peakGB':>7} {'target':>8} {'rest':>8} {'recon':>7}")

    for predict_spans, candidates in QUALITY_LADDER:
        batch = processor(audios=[str(clip)], descriptions=[prompt]).to("cuda")
        trial, target, residual = _quality_trial(model, batch, predict_spans, candidates)
        say(_quality_row(trial))
        if target is None or residual is None:
            continue
        name = f"{stem}__{prompt.replace(' ', '_')}__spans{int(predict_spans)}__k{candidates}"
        _save_pcm16_wav(output_dir / f"{name}__sound.wav", target, sample_rate)
        _save_pcm16_wav(output_dir / f"{name}__rest.wav", residual, sample_rate)

    WEIGHTS_VOLUME.commit()
    say(f"wrote WAVs to {output_dir}")
    return "\n".join(lines)


@app.function(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME},
    secrets=[HF_SECRET],
    timeout=MEASURE_TIMEOUT_SECONDS,
)
def rerank(
    model_id: str = DEFAULT_MODEL_ID,
    prompt: str = QUALITY_PROMPT,
    candidates: int = 4,
) -> str:
    """Draw candidates one at a time and use CLAP to select the best text match.

    Keeping every completed candidate on the CPU prevents their activations from accumulating on
    a 24 GB GPU; only the small stacked outputs return to the GPU for one CLAP scoring pass.
    """
    os.environ["HF_HOME"] = f"{WEIGHTS_PATH}/huggingface"

    import torch
    from sam_audio import SAMAudio, SAMAudioProcessor

    logging.basicConfig(level=logging.INFO)
    lines: list[str] = []

    def say(text: str) -> None:
        lines.append(text)
        LOGGER.info(text)

    if candidates < 1:
        say("candidates must be at least 1")
        return "\n".join(lines)

    output_dir = Path(WEIGHTS_PATH) / "measure"
    output_dir.mkdir(parents=True, exist_ok=True)
    clip = output_dir / "clip.wav"
    if not clip.exists():
        subprocess.run(_clip_argv(str(clip)), check=True)

    properties = torch.cuda.get_device_properties(0)
    started = time.perf_counter()
    model = SAMAudio.from_pretrained(model_id, **_quality_load_kwargs()).eval().cuda()
    processor = SAMAudioProcessor.from_pretrained(model_id)
    load_seconds = time.perf_counter() - started
    sample_rate = int(processor.audio_sampling_rate)
    stem = model_id.rsplit("/", 1)[-1]

    say(f"{stem} on {properties.name} ({properties.total_memory / GIGABYTE:.1f} GB)")
    say(f"warm load with CLAP text_ranker and the default span predictor: {load_seconds:.1f}s")
    say(f"prompt: {prompt!r}")

    results: list[RerankCandidate] = []
    targets: list[torch.Tensor] = []
    residuals: list[torch.Tensor] = []
    for index in range(candidates):
        say(f"drawing candidate {index + 1}/{candidates}")
        result, target, residual = _draw_rerank_candidate(model, processor, clip, prompt, index + 1)
        results.append(result)
        targets.append(target)
        residuals.append(residual)

    winner, worst = _score_rerank_candidates(model, prompt, sample_rate, targets, results)
    winner_index = winner["index"]
    score_spread = winner["clap_score"] - worst["clap_score"]

    say(f"{'cand':>4} {'secs':>6} {'peakGB':>7} {'target':>8} {'rest':>8} {'recon':>7} {'CLAP':>8}")
    for result in results:
        say(_rerank_row(result))
    say(f"CLAP winner: candidate {winner_index}")
    say(
        f"CLAP spread: best {winner['clap_score']:.5f}, worst {worst['clap_score']:.5f}, "
        f"difference {score_spread:.5f}"
    )

    for result, target, residual in zip(results, targets, residuals, strict=True):
        outcome = "winner" if result["index"] == winner_index else "candidate"
        name = (
            f"{stem}__{prompt.replace(' ', '_')}__candidate{result['index']:02d}"
            f"__clap{result['clap_score']:+.5f}__{outcome}"
        )
        _save_pcm16_wav(output_dir / f"{name}__sound.wav", target, sample_rate)
        _save_pcm16_wav(output_dir / f"{name}__rest.wav", residual, sample_rate)

    WEIGHTS_VOLUME.commit()
    say(f"wrote {2 * candidates} WAVs to {output_dir}")
    return "\n".join(lines)


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
VISUAL_FRAMES_FILE = "visual/orchestra_frames.pt"
VISUAL_AUDIO_FILE = "visual/orchestra.wav"


class VisualTrial(TypedDict):
    """One separation of the same clip, prompted either by a mask or by text."""

    label: str
    mode: str
    seconds: float
    peak_vram_gb: float
    sound_rms: float
    rest_rms: float
    reconstruction_error: float
    error: str


def _box_masked_frames(frames: "torch.Tensor", box: tuple[int, int, int, int]) -> "torch.Tensor":
    """Build the mask `mask_videos` expects for one box.

    `SAMAudioProcessor.mask_videos` computes `video * mask.eq(0)`, so it keeps the pixels where the
    mask is **zero** and blanks the rest. A mask straight from a segmenter marks the object with
    ones, which would hand the model the background instead; this inverts it, so the region inside
    the box is what survives.
    """
    import torch

    mask = torch.ones_like(frames)
    x, y, width, height = box
    mask[:, :, y : y + height, x : x + width] = 0
    return mask


def _visual_batch(
    processor: "SAMAudioProcessor",
    frames: "torch.Tensor",
    clip: str,
    mode: str,
    target: VisualTarget,
) -> "Batch":
    """Build one trial's batch: a masked video for `mask`, a text description for `text`."""
    _, prompt, x, y, width, height = target
    if mode == "mask":
        masked = processor.mask_videos(
            [frames], [_box_masked_frames(frames, (x, y, width, height))]
        )
        return processor(audios=[clip], descriptions=[""], masked_videos=masked).to("cuda")
    return processor(audios=[clip], descriptions=[prompt]).to("cuda")


@app.function(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME},
    secrets=[HF_SECRET],
    timeout=MEASURE_TIMEOUT_SECONDS,
)
def visual_probe(model_id: str = DEFAULT_MODEL_ID) -> str:
    """Separate the same clip by mask and by text, and compare.

    Answers the question the product depends on: does pointing at a performer isolate that
    performer, and does it beat simply typing what they play? Every trial writes its own WAV.
    """
    os.environ["HF_HOME"] = f"{WEIGHTS_PATH}/huggingface"

    import torch
    from sam_audio import SAMAudio, SAMAudioProcessor

    logging.basicConfig(level=logging.INFO)
    lines: list[str] = []

    def say(text: str) -> None:
        lines.append(text)
        LOGGER.info(text)

    output_dir = Path(WEIGHTS_PATH) / "visual_probe"
    output_dir.mkdir(parents=True, exist_ok=True)
    clip = str(Path(WEIGHTS_PATH) / VISUAL_AUDIO_FILE)
    frames = torch.load(Path(WEIGHTS_PATH) / VISUAL_FRAMES_FILE)

    properties = torch.cuda.get_device_properties(0)
    model = SAMAudio.from_pretrained(model_id, **RANKERS_OFF).eval().cuda()
    processor = SAMAudioProcessor.from_pretrained(model_id)
    sample_rate = int(processor.audio_sampling_rate)

    say(f"{model_id} on {properties.name} ({properties.total_memory / GIGABYTE:.1f} GB)")
    say(f"frames {tuple(frames.shape)} {frames.dtype}")
    say(f"{'target':8} {'mode':7} {'secs':>6} {'peakGB':>7} {'target':>8} {'rest':>8} {'recon':>7}")

    for visual_target in VISUAL_TARGETS:
        label = visual_target[0]
        for mode in ("mask", "text"):
            trial: VisualTrial = {
                "label": label,
                "mode": mode,
                "seconds": 0.0,
                "peak_vram_gb": 0.0,
                "sound_rms": 0.0,
                "rest_rms": 0.0,
                "reconstruction_error": 0.0,
                "error": "",
            }
            torch.cuda.reset_peak_memory_stats()
            started = time.perf_counter()
            try:
                batch = _visual_batch(processor, frames, clip, mode, visual_target)
                with torch.inference_mode():
                    separation = model.separate(batch, predict_spans=False, reranking_candidates=1)
            except Exception as error:  # one failing mode must not end the comparison
                trial["seconds"] = round(time.perf_counter() - started, 1)
                trial["error"] = f"{type(error).__name__}: {error}"
                say(f"{label:8} {mode:7} FAILED {trial['error'][:70]}")
                torch.cuda.empty_cache()
                continue

            trial["seconds"] = round(time.perf_counter() - started, 1)
            trial["peak_vram_gb"] = round(torch.cuda.max_memory_allocated() / GIGABYTE, 3)
            mix = batch.audios.detach().float().flatten().cpu()
            target = separation.target[0].detach().float().cpu()
            residual = separation.residual[0].detach().float().cpu()
            mix_rms = max(_rms(mix), 1e-9)
            trial["sound_rms"] = round(_rms(target), 5)
            trial["rest_rms"] = round(_rms(residual), 5)
            trial["reconstruction_error"] = round(_rms(mix - (target + residual)) / mix_rms, 5)
            _save_pcm16_wav(output_dir / f"{label}__{mode}__sound.wav", target, sample_rate)
            say(
                f"{label:8} {mode:7} {trial['seconds']:6.1f} {trial['peak_vram_gb']:7.2f} "
                f"{trial['sound_rms']:8.5f} {trial['rest_rms']:8.5f} "
                f"{trial['reconstruction_error']:7.3f}"
            )
            torch.cuda.empty_cache()

    WEIGHTS_VOLUME.commit()
    say(f"wrote WAVs to {output_dir}")
    return "\n".join(lines)


VISUAL_COMPARE_PROMPT = "piano"


@app.function(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME, "/cache": modal.Volume.from_name("mixray-cache")},
    secrets=[HF_SECRET],
    timeout=MEASURE_TIMEOUT_SECONDS,
)
def visual_vs_text(clip_id: str, track_id: str, prompt: str = VISUAL_COMPARE_PROMPT) -> str:
    """Isolate the same source twice, once from a tracked mask and once from a text prompt.

    This is the measurement the product rests on: pointing costs about nine times the latency of
    typing, so it has to be worth it.
    """
    import json

    os.environ["HF_HOME"] = f"{WEIGHTS_PATH}/huggingface"

    import torch
    from sam_audio import SAMAudio, SAMAudioProcessor

    logging.basicConfig(level=logging.INFO)
    lines: list[str] = []

    def say(text: str) -> None:
        lines.append(text)
        LOGGER.info(text)

    cache = Path("/cache")
    track_path = cache / "clips" / clip_id / "tracks" / f"{track_id}.json"
    track = json.loads(track_path.read_text(encoding="utf-8"))

    model = SAMAudio.from_pretrained(DEFAULT_MODEL_ID, **RANKERS_OFF).eval().cuda()
    processor = SAMAudioProcessor.from_pretrained(DEFAULT_MODEL_ID)
    properties = torch.cuda.get_device_properties(0)
    say(f"{DEFAULT_MODEL_ID} on {properties.name}, track {track_id}, text prompt {prompt!r}")

    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    visual = run_visual_isolation(
        clip_id, f"{track_id}_visual", track, model=model, processor=processor, cache_root=cache
    )
    say(
        f"visual: {time.perf_counter() - started:5.1f}s  "
        f"peak {torch.cuda.max_memory_allocated() / GIGABYTE:5.2f} GB  -> {visual['sound_url']}"
    )

    torch.cuda.reset_peak_memory_stats()
    started = time.perf_counter()
    text = run_isolation(
        clip_id,
        f"{track_id}_text",
        prompt,
        "Text",
        model=model,
        processor=processor,
        cache_root=cache,
    )
    say(
        f"text:   {time.perf_counter() - started:5.1f}s  "
        f"peak {torch.cuda.max_memory_allocated() / GIGABYTE:5.2f} GB  -> {text['sound_url']}"
    )
    return "\n".join(lines)
