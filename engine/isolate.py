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

if TYPE_CHECKING:
    import torch

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
