"""SAM Audio: pull one named sound out of a clip and leave everything else behind.

`run_isolation` separates a named sound from a cached clip, whether the name was typed, suggested,
or given by Muse Spark to an area drawn on the video.
"""

import logging
import math
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
    from sam_audio.ranking.ranker import Ranker


LOGGER = logging.getLogger(__name__)


WEIGHTS_VOLUME = modal.Volume.from_name("mixray-weights", create_if_missing=True)
WEIGHTS_PATH = "/weights"
HF_SECRET = modal.Secret.from_name("mixray-hf")
# With the span predictor resident, one draw of `sam-audio-large` measured 28.13 GiB of peak VRAM.
ISOLATION_GPU = ["A100-40GB"]

# Meta's own subjective table puts large above small on music (4.22 vs 4.11), on professional
# instrument separation (4.49 vs 4.24) and in the wild (3.66 vs 3.56); base is worse than small on
# music and is not a candidate.
DEFAULT_MODEL_ID = "facebook/sam-audio-large"
# Meta's paper uses eight candidates. On ten unseen targets one unranked draw scored note agreement
# 0.281 and the Judge's pick of eight scored 0.479, so a single draw is only for sounds with no
# notes.
INSTRUMENT_DRAWS = 8
EVENT_DRAWS = 1
# A prompt for an absent sound returned about -62 dB in three of three controls, while 21 of 22
# present events stayed above -21 dB. The one below this bar was a failed output with SI-SDR
# improvement -62 dB.
ABSENT_OUTPUT_LEVEL_DB = -40.0
# Judge splits draws into two groups: empty ones near 1, real ones above 3.9 (48 draws, 6 sounds).
MIN_CANDIDATE_SCORE = 2.0
# Dropping the two built-in rankers keeps ImageBind and CLAP from being built: candidates are drawn
# one at a time and ranked by Judge, which holds VRAM flat. The span predictor stays, because it
# took car horn from -14.6 to +19.2 dB. Do NOT pass `strict=False`: `SAMAudio.load_state_dict`
# (`sam_audio/model/model.py`) has `if strict:` with no `else:` branch, so `strict=False` silently
# skips loading `checkpoint.pt` and leaves the entire model randomly initialized.
BUILT_IN_RANKERS_OFF = {"visual_ranker": None, "text_ranker": None}


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


NORMALIZATION_TARGET_PEAK = 0.891
MINIMUM_NORMALIZATION_PEAK = 0.010


MASK_FFT_SIZE = 2048
MASK_HOP = 512
MASK_POWER = 2.0


def _mask_onto_mix(
    sound: "torch.Tensor", rest: "torch.Tensor", mix: "torch.Tensor"
) -> tuple["torch.Tensor", "torch.Tensor"]:
    """Turn SAM Audio's sound and rest into a time-frequency mask and apply it to the real mix.

    SAM Audio resynthesises through its codec, so its audio has none of the recording's phase and
    softens note starts. Its two outputs still say, cell by cell, how much belongs to the sound. On
    a café piano this kept SAM Audio's steam rejection, 10 dB better than Demucs, and suppressed a
    knock better than either. The outputs are loudness-normalised separately, so their scales are
    fitted to the mix first.
    """
    import torch

    length = min(sound.shape[-1], rest.shape[-1], mix.shape[-1])
    window = torch.hann_window(MASK_FFT_SIZE)

    def spectrum(signal: "torch.Tensor") -> "torch.Tensor":
        return torch.stft(
            signal[:length].float(), MASK_FFT_SIZE, MASK_HOP, window=window, return_complex=True
        )

    mixture = spectrum(mix)
    sound_mag = spectrum(sound).abs()
    rest_mag = spectrum(rest).abs()
    target = mixture.abs().reshape(-1)
    basis = torch.stack([sound_mag.reshape(-1), rest_mag.reshape(-1)], dim=1).double()
    scales = torch.linalg.lstsq(basis, target.double().unsqueeze(1)).solution.squeeze(1)
    sound_scale, rest_scale = (float(value) for value in scales.clamp(min=1e-6))
    sound_power = (sound_scale * sound_mag) ** MASK_POWER
    rest_power = (rest_scale * rest_mag) ** MASK_POWER
    mask = sound_power / (sound_power + rest_power + 1e-12)
    masked = torch.istft(mixture * mask, MASK_FFT_SIZE, MASK_HOP, window=window, length=length)
    return masked, mix[:length].float() - masked


def _rms(waveform: "torch.Tensor") -> float:
    return float(waveform.pow(2).mean().sqrt())


def _normalize_tensor(waveform: "torch.Tensor") -> "torch.Tensor":
    """Scale a non-silent waveform to -1.0 dBFS peak so it plays at full master volume."""
    peak = float(waveform.abs().max().item())
    if peak > MINIMUM_NORMALIZATION_PEAK:
        return waveform * (NORMALIZATION_TARGET_PEAK / peak)
    return waveform


class CandidatesRejectedError(Exception):
    """Every SAM Audio draw came back empty, though Demucs found the sound in the clip."""


class SoundNotFoundError(Exception):
    """The requested sound is not audible in this clip, so there is nothing to isolate."""


def _pick_candidate(
    candidates: list["torch.Tensor"],
    *,
    mix: "torch.Tensor",
    prompt: str,
    ranker: "Ranker",
    sample_rate: int,
) -> tuple[int, float]:
    """Return the draw Judge scores highest for this prompt against this mix, and its score."""
    import torch

    shared = min(int(mix.shape[-1]), *(int(candidate.shape[-1]) for candidate in candidates))
    source = mix[:shared].unsqueeze(0)
    # Scored one at a time: eight candidates in one Judge batch ran a 40 GB card out of memory.
    torch.cuda.empty_cache()
    values: list[float] = []
    for candidate in candidates:
        scores = ranker(
            input_audio=[source],
            extracted_audio=[candidate[:shared].unsqueeze(0).to(source.device)],
            descriptions=[prompt],
            sample_rate=sample_rate,
        )
        values.append(float(scores[0].detach().float().cpu().reshape(-1)[0]))
    LOGGER.info("candidate scores for %s: %s", prompt, values)
    best = max(range(len(values)), key=values.__getitem__)
    return best, values[best]


def cached_isolation(
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
def persist_isolation(  # noqa: PLR0913
    clip_id: str,
    iso_id: str,
    *,
    label: str,
    prompt: str,
    method: IsolationMethod,
    sound: "torch.Tensor",
    rest: "torch.Tensor",
    sample_rate: int,
    cache_root: Path,
    iso_dir: Path,
    cached_json: Path,
    trackmap_url: str,
) -> IsolationEntry:
    """Write one completed separation using the shared isolation sidecar format."""
    import json

    iso_dir.mkdir(parents=True, exist_ok=True)
    sound_wav = iso_dir / "sound.wav"
    rest_wav = iso_dir / "rest.wav"
    norm_sound = _normalize_tensor(sound)
    norm_rest = _normalize_tensor(rest)
    _save_pcm16_wav(sound_wav, norm_sound, sample_rate)
    _save_pcm16_wav(rest_wav, norm_rest, sample_rate)
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
    ranker: "Ranker",
    draws: int,
    onto_mix: bool,
    cache_root: Path,
    iso_dir: Path,
    cached_json: Path,
    trackmap_url: str,
) -> IsolationEntry:
    """Draw SAM Audio separations with span prediction, keep the best, and persist it."""
    import torch

    sounds: list[torch.Tensor] = []
    rests: list[torch.Tensor] = []
    started = time.perf_counter()
    with torch.inference_mode():
        for _ in range(draws):
            separation = model.separate(batch, predict_spans=True, reranking_candidates=1)
            # Kept off the GPU, so the draws do not pile up against Judge's own memory.
            sounds.append(separation.target[0].detach().float().cpu())
            rests.append(separation.residual[0].detach().float().cpu())
    LOGGER.info(
        "drew %d for %s (%s) in %.2fs", draws, clip_id, prompt, time.perf_counter() - started
    )

    sample_rate = int(model.audio_codec.sample_rate)
    sizes = model.audio_codec.feature_idx_to_wav_idx(batch.sizes)
    # SAM Audio returns mono candidates, so the mix is downmixed rather than flattened: flattening
    # a multi-channel tensor would interleave the channels into noise.
    mix = batch.audios[0][:, : sizes[0]].detach().mean(dim=0)
    chosen = 0
    if draws > 1:
        with torch.inference_mode():
            chosen, score = _pick_candidate(
                sounds, mix=mix, prompt=prompt, ranker=ranker, sample_rate=sample_rate
            )
        if score < MIN_CANDIDATE_SCORE:
            raise CandidatesRejectedError(prompt)
    sound, rest = sounds[chosen], rests[chosen]
    if onto_mix:
        sound, rest = _mask_onto_mix(sound, rest, mix.float().cpu())
    level = 20.0 * math.log10(max(_rms(sound), 1e-12) / max(_rms(mix.float().cpu()), 1e-12))
    if level < ABSENT_OUTPUT_LEVEL_DB:
        LOGGER.info("output sits %.1f dB under the mix for %s (%s)", level, clip_id, prompt)
        raise SoundNotFoundError(prompt)
    return persist_isolation(
        clip_id,
        iso_id,
        label=label,
        prompt=prompt,
        method=method,
        sound=sound,
        rest=rest,
        sample_rate=sample_rate,
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
    ranker: "Ranker",
    draws: int,
    onto_mix: bool = False,
    cache_root: Path | None = None,
) -> IsolationEntry:
    """Separate `prompt` from `clip_id` with SAM Audio and persist sound, rest, and peaks."""
    root = cache_root if cache_root is not None else get_cache_root()
    iso_dir, cached_json, trackmap_url, cached = cached_isolation(clip_id, iso_id, root)
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
        ranker=ranker,
        draws=draws,
        onto_mix=onto_mix,
        cache_root=root,
        iso_dir=iso_dir,
        cached_json=cached_json,
        trackmap_url=trackmap_url,
    )
