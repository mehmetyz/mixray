"""Build an actionable synth recipe for an isolated sound with Muse Spark Open.

Muse Spark Open receives deterministic text features rather than the WAV itself. This keeps the
partner request small and makes the recipe reproducible while the serving stack's audio content
part format remains unverified.
"""

from __future__ import annotations

import json
import logging
import math
import os
from pathlib import Path
from typing import TypedDict, TypeGuard

import modal

from images import analyze_image
from ingest import DEFAULT_CACHE_PATH, build_served_trackmap, clip_dir, get_cache_root

LOGGER = logging.getLogger(__name__)

app = modal.App("mixray-recipe")

CACHE_VOLUME = modal.Volume.from_name("mixray-cache", create_if_missing=True)
BASETEN_SECRET = modal.Secret.from_name("mixray-baseten")

RECIPE_TIMEOUT_SECONDS = 180
REQUEST_TIMEOUT_SECONDS = 45
RECIPE_ATTEMPTS = 3
FRAME_LENGTH = 2048
HOP_LENGTH = 512
ENVELOPE_SHARE = 0.1
MIDI_MAX = 127

BASETEN_CHAT_COMPLETIONS_URL = "https://inference.baseten.co/v1/chat/completions"
# This is the hackathon-reserved Muse Spark Open id, not Baseten's generic public model id.
MUSE_SPARK_OPEN_MODEL = "meta-models/muse-spark-open-1026"


class PitchRange(TypedDict):
    """The MIDI range already known for the isolated part."""

    low: int
    high: int


class MusicalKey(TypedDict):
    """The analysed key supplied as recipe context."""

    tonic: str
    mode: str


class RmsEnvelopeSummary(TypedDict):
    """A compact RMS envelope that makes the onset and tail explicit."""

    initial_rms: float
    peak_rms: float
    tail_rms: float
    attack_seconds: float
    decay_ratio: float


class HarmonicPercussiveBalance(TypedDict):
    """RMS energy split from harmonic-percussive source separation."""

    harmonic_rms: float
    percussive_rms: float
    harmonic_share: float


class SpectralStatistics(TypedDict):
    """Deterministic audio features supplied to Muse Spark Open."""

    duration_seconds: float
    sample_rate_hz: int
    spectral_centroid_hz: float
    spectral_bandwidth_hz: float
    spectral_rolloff_hz: float
    spectral_flatness: float
    zero_crossing_rate: float
    rms_envelope: RmsEnvelopeSummary
    harmonic_percussive_balance: HarmonicPercussiveBalance


class RecipeContext(TypedDict):
    """The musical and signal context used to infer one sound's patch."""

    prompt: str
    label: str
    note_range: PitchRange | None
    key: MusicalKey
    spectral_statistics: SpectralStatistics


class RecipeOscillator(TypedDict):
    """One oscillator layer and its unison settings."""

    wave: str
    count: int
    unison: int
    voices: int
    detune_cents: float
    mix: float


class RecipeFilter(TypedDict):
    """The subtractive filter settings a producer can reproduce."""

    type: str
    cutoff_hz: float
    resonance: str
    character: str


class RecipeEnvelope(TypedDict):
    """An ADSR envelope expressed in milliseconds and normalized sustain."""

    attack_ms: float
    decay_ms: float
    sustain: float
    release_ms: float


class RecipeFilterEnvelope(RecipeEnvelope):
    """A filter ADSR envelope plus its cutoff modulation amount."""

    amount: float


class RecipeEffect(TypedDict):
    """One ordered effect in the recommended chain."""

    type: str
    mix: float
    settings: str


class SoundRecipe(TypedDict):
    """The recipe fields Mixray promises to the Take-home screen."""

    summary: str
    oscillators: list[RecipeOscillator]
    filter: RecipeFilter
    amp_env: RecipeEnvelope
    filter_env: RecipeFilterEnvelope
    fx: list[RecipeEffect]


class ChatMessage(TypedDict):
    """One verified Baseten chat-completions message."""

    role: str
    content: str


class ChatCompletionRequest(TypedDict):
    """The exact Baseten request shape accepted by Muse Spark Open."""

    model: str
    messages: list[ChatMessage]


def _is_json_object(value: object) -> TypeGuard[dict[str, object]]:
    """Narrow untrusted JSON objects before inspecting their fields."""
    return isinstance(value, dict) and all(isinstance(key, str) for key in value)


def _required_string(value: object, field: str) -> str:
    """Return one non-empty model string or reject the malformed reply."""
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError(f"recipe reply {field} must be a non-empty string")
    return value.strip()


def _required_int(value: object, field: str, minimum: int) -> int:
    """Return one bounded JSON integer without accepting booleans."""
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise RuntimeError(f"recipe reply {field} must be an integer of at least {minimum}")
    return value


def _required_number(value: object, field: str, minimum: float, maximum: float) -> float:
    """Return one finite bounded JSON number without accepting booleans."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise RuntimeError(f"recipe reply {field} must be a number")
    number = float(value)
    if not math.isfinite(number) or not minimum <= number <= maximum:
        raise RuntimeError(f"recipe reply {field} must be between {minimum} and {maximum}")
    return number


def _parse_envelope(raw: object, field: str) -> RecipeEnvelope:
    """Validate an amp-envelope object at the model boundary."""
    if not _is_json_object(raw):
        raise RuntimeError(f"recipe reply {field} must be an object")
    return {
        "attack_ms": _required_number(raw.get("attack_ms"), f"{field}.attack_ms", 0.0, 60_000.0),
        "decay_ms": _required_number(raw.get("decay_ms"), f"{field}.decay_ms", 0.0, 60_000.0),
        "sustain": _required_number(raw.get("sustain"), f"{field}.sustain", 0.0, 1.0),
        "release_ms": _required_number(raw.get("release_ms"), f"{field}.release_ms", 0.0, 60_000.0),
    }


def parse_recipe(raw: str) -> SoundRecipe:
    """Validate the untrusted Muse Spark Open JSON before it reaches a trackmap."""
    parsed = json.loads(raw)
    if not _is_json_object(parsed):
        raise RuntimeError("recipe reply was not an object")

    raw_oscillators = parsed.get("oscillators")
    if not isinstance(raw_oscillators, list) or not raw_oscillators:
        raise RuntimeError("recipe reply oscillators must be a non-empty array")
    oscillators: list[RecipeOscillator] = []
    for index, raw_oscillator in enumerate(raw_oscillators):
        if not _is_json_object(raw_oscillator):
            raise RuntimeError(f"recipe reply oscillators[{index}] must be an object")
        unison = _required_int(raw_oscillator.get("unison"), f"oscillators[{index}].unison", 1)
        oscillators.append(
            {
                "wave": _required_string(raw_oscillator.get("wave"), f"oscillators[{index}].wave"),
                "count": _required_int(
                    raw_oscillator.get("count"), f"oscillators[{index}].count", 1
                ),
                "unison": unison,
                # RecipeCard reads `voices`; keeping it equal to unison makes the JSON convenient
                # for both DAW users and the existing renderer.
                "voices": unison,
                "detune_cents": _required_number(
                    raw_oscillator.get("detune_cents"),
                    f"oscillators[{index}].detune_cents",
                    0.0,
                    100.0,
                ),
                "mix": _required_number(
                    raw_oscillator.get("mix"), f"oscillators[{index}].mix", 0.0, 1.0
                ),
            }
        )

    raw_filter = parsed.get("filter")
    if not _is_json_object(raw_filter):
        raise RuntimeError("recipe reply filter must be an object")
    recipe_filter: RecipeFilter = {
        "type": _required_string(raw_filter.get("type"), "filter.type"),
        "cutoff_hz": _required_number(
            raw_filter.get("cutoff_hz"), "filter.cutoff_hz", 10.0, 48_000.0
        ),
        "resonance": _required_string(raw_filter.get("resonance"), "filter.resonance"),
        "character": _required_string(raw_filter.get("character"), "filter.character"),
    }

    raw_filter_env = parsed.get("filter_env")
    filter_envelope = _parse_envelope(raw_filter_env, "filter_env")
    if not _is_json_object(raw_filter_env):
        raise RuntimeError("recipe reply filter_env must be an object")
    filter_env: RecipeFilterEnvelope = {
        **filter_envelope,
        "amount": _required_number(raw_filter_env.get("amount"), "filter_env.amount", -1.0, 1.0),
    }

    raw_effects = parsed.get("fx")
    if not isinstance(raw_effects, list):
        raise RuntimeError("recipe reply fx must be an array")
    effects: list[RecipeEffect] = []
    for index, raw_effect in enumerate(raw_effects):
        if not _is_json_object(raw_effect):
            raise RuntimeError(f"recipe reply fx[{index}] must be an object")
        effects.append(
            {
                "type": _required_string(raw_effect.get("type"), f"fx[{index}].type"),
                "mix": _required_number(raw_effect.get("mix"), f"fx[{index}].mix", 0.0, 1.0),
                "settings": _required_string(raw_effect.get("settings"), f"fx[{index}].settings"),
            }
        )

    return {
        "summary": _required_string(parsed.get("summary"), "summary"),
        "oscillators": oscillators,
        "filter": recipe_filter,
        "amp_env": _parse_envelope(parsed.get("amp_env"), "amp_env"),
        "filter_env": filter_env,
        "fx": effects,
    }


def spectral_statistics(wav_path: Path) -> SpectralStatistics:
    """Compute the named features that describe an isolated sound without uploading it."""
    import librosa
    import numpy as np

    samples, loaded_rate = librosa.load(str(wav_path), sr=None, mono=True)
    sample_rate = int(loaded_rate)
    if sample_rate <= 0 or samples.size == 0:
        raise ValueError(f"isolated sound is empty: {wav_path}")

    centroid = librosa.feature.spectral_centroid(
        y=samples, sr=sample_rate, n_fft=FRAME_LENGTH, hop_length=HOP_LENGTH
    )
    bandwidth = librosa.feature.spectral_bandwidth(
        y=samples, sr=sample_rate, n_fft=FRAME_LENGTH, hop_length=HOP_LENGTH
    )
    rolloff = librosa.feature.spectral_rolloff(
        y=samples, sr=sample_rate, n_fft=FRAME_LENGTH, hop_length=HOP_LENGTH
    )
    flatness = librosa.feature.spectral_flatness(
        y=samples, n_fft=FRAME_LENGTH, hop_length=HOP_LENGTH
    )
    zero_crossing = librosa.feature.zero_crossing_rate(
        samples, frame_length=FRAME_LENGTH, hop_length=HOP_LENGTH
    )
    rms = librosa.feature.rms(y=samples, frame_length=FRAME_LENGTH, hop_length=HOP_LENGTH)[0]
    if rms.size == 0:
        raise ValueError(f"isolated sound has no RMS frames: {wav_path}")
    envelope_count = max(1, math.ceil(rms.size * ENVELOPE_SHARE))
    peak_index = int(np.argmax(rms))
    peak_rms = float(rms[peak_index])
    harmonic, percussive = librosa.effects.hpss(samples)
    harmonic_rms = float(np.sqrt(np.mean(np.square(harmonic))))
    percussive_rms = float(np.sqrt(np.mean(np.square(percussive))))
    total_hpss_rms = harmonic_rms + percussive_rms

    return {
        "duration_seconds": round(float(samples.size / sample_rate), 4),
        "sample_rate_hz": sample_rate,
        "spectral_centroid_hz": round(float(np.mean(centroid)), 2),
        "spectral_bandwidth_hz": round(float(np.mean(bandwidth)), 2),
        "spectral_rolloff_hz": round(float(np.mean(rolloff)), 2),
        "spectral_flatness": round(float(np.mean(flatness)), 5),
        "zero_crossing_rate": round(float(np.mean(zero_crossing)), 5),
        "rms_envelope": {
            "initial_rms": round(float(np.mean(rms[:envelope_count])), 6),
            "peak_rms": round(peak_rms, 6),
            "tail_rms": round(float(np.mean(rms[-envelope_count:])), 6),
            "attack_seconds": round(float(peak_index * HOP_LENGTH / sample_rate), 4),
            "decay_ratio": round(float(rms[-1] / peak_rms) if peak_rms > 0.0 else 0.0, 5),
        },
        "harmonic_percussive_balance": {
            "harmonic_rms": round(harmonic_rms, 6),
            "percussive_rms": round(percussive_rms, 6),
            "harmonic_share": round(
                harmonic_rms / total_hpss_rms if total_hpss_rms > 0.0 else 0.0, 5
            ),
        },
    }


def _read_pitch_range(isolation: dict[str, object]) -> PitchRange | None:
    """Read the optional transcription range when it has completed before recipe generation."""
    raw_range = isolation.get("range")
    if not _is_json_object(raw_range):
        return None
    low = raw_range.get("low")
    high = raw_range.get("high")
    if (
        isinstance(low, bool)
        or isinstance(high, bool)
        or not isinstance(low, int)
        or not isinstance(high, int)
    ):
        return None
    if low < 0 or high < low or high > MIDI_MAX:
        return None
    return {"low": low, "high": high}


def _read_key(trackmap: dict[str, object]) -> MusicalKey:
    """Read the track's known key, failing clearly if its base TrackMap is malformed."""
    raw_key = trackmap.get("key")
    if not _is_json_object(raw_key):
        raise ValueError("trackmap key is missing")
    return {
        "tonic": _required_string(raw_key.get("tonic"), "trackmap key tonic"),
        "mode": _required_string(raw_key.get("mode"), "trackmap key mode"),
    }


def recipe_context(
    clip_id: str, isolation_id: str, cache_root: Path | None = None
) -> RecipeContext:
    """Collect the isolation, trackmap, and statistics context for one Baseten request."""
    root = cache_root if cache_root is not None else get_cache_root()
    isolation_dir = clip_dir(clip_id, root) / "isolations" / isolation_id
    isolation_path = isolation_dir / "isolation.json"
    wav_path = isolation_dir / "sound.wav"
    if not isolation_path.exists():
        raise FileNotFoundError(f"no isolation entry for {isolation_id}")
    if not wav_path.exists():
        raise FileNotFoundError(f"no isolated WAV for {isolation_id}")
    loaded = json.loads(isolation_path.read_text(encoding="utf-8"))
    if not _is_json_object(loaded):
        raise ValueError(f"isolation entry is not an object: {isolation_path}")
    trackmap = build_served_trackmap(clip_id, root)
    raw_isolations = trackmap.get("isolations")
    served_isolation = loaded
    if isinstance(raw_isolations, list):
        for candidate in raw_isolations:
            if _is_json_object(candidate) and candidate.get("id") == isolation_id:
                served_isolation = candidate
                break
    return {
        "prompt": _required_string(loaded.get("prompt"), "isolation prompt"),
        "label": _required_string(loaded.get("label"), "isolation label"),
        "note_range": _read_pitch_range(served_isolation),
        "key": _read_key(trackmap),
        "spectral_statistics": spectral_statistics(wav_path),
    }


def recipe_prompt(context: RecipeContext) -> str:
    """Turn typed local observations into a constrained producer-facing JSON instruction."""
    context_json = json.dumps(context, indent=2, sort_keys=True)
    return (
        "You are a meticulous synth programmer. Infer a practical starting patch for the isolated "
        "sound from this deterministic analysis. Do not claim certainty; make the settings useful "
        "for rebuilding the sound in a subtractive synth or DAW. Return JSON only, with no "
        "Markdown "
        "fences or prose outside JSON.\n\n"
        "The JSON object must contain exactly these fields: `summary` (one readable sentence), "
        "`oscillators` (a non-empty array of objects with `wave` string, `count` integer >= 1, "
        "`unison` integer >= 1, `detune_cents` number 0..100, and `mix` number 0..1), `filter` "
        "(object with `type` string, `cutoff_hz` number, `resonance` string, `character` string), "
        "`amp_env` (object with `attack_ms`, `decay_ms`, `sustain`, `release_ms` numbers), "
        "`filter_env` (the same ADSR numbers plus `amount` between -1 and 1), and `fx` (an "
        "array in "
        "signal-chain order; each object has `type` string, `mix` number 0..1, and `settings` "
        "string).\n\n"
        f"Analysis:\n{context_json}"
    )


def baseten_api_key() -> str:
    """Read this stage's dedicated partner-inference key without ever logging it."""
    key = os.environ.get("BASETEN_API_KEY", "").strip()
    if not key:
        raise RuntimeError("BASETEN_API_KEY is missing from the mixray-baseten Modal Secret")
    return key


def _response_content(payload: object) -> str:
    """Extract chat-completions text while validating Baseten's untrusted response shape."""
    if not _is_json_object(payload):
        raise RuntimeError("Baseten reply was not an object")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("Baseten reply had no choices")
    first_choice = choices[0]
    if not _is_json_object(first_choice):
        raise RuntimeError("Baseten reply choice was not an object")
    message = first_choice.get("message")
    if not _is_json_object(message):
        raise RuntimeError("Baseten reply had no message")
    return _required_string(message.get("content"), "content")


def request_recipe(context: RecipeContext, key: str) -> SoundRecipe:
    """Call Baseten and retry malformed model JSON a fixed number of times."""
    import httpx

    payload: ChatCompletionRequest = {
        "model": MUSE_SPARK_OPEN_MODEL,
        "messages": [{"role": "user", "content": recipe_prompt(context)}],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    last_error: Exception | None = None
    for attempt in range(1, RECIPE_ATTEMPTS + 1):
        try:
            response = httpx.post(
                BASETEN_CHAT_COMPLETIONS_URL,
                headers=headers,
                json=payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            return parse_recipe(_response_content(response.json()))
        except (httpx.HTTPError, json.JSONDecodeError, RuntimeError) as error:
            last_error = error
            LOGGER.warning(
                "recipe attempt %d/%d returned an unusable response", attempt, RECIPE_ATTEMPTS
            )
    raise RuntimeError(
        f"Muse Spark Open returned no valid recipe after {RECIPE_ATTEMPTS} attempts"
    ) from last_error


def write_recipe(clip_id: str, isolation_id: str, cache_root: Path | None = None) -> SoundRecipe:
    """Create the recipe sidecar without mutating the producer-owned TrackMap."""
    root = cache_root if cache_root is not None else get_cache_root()
    context = recipe_context(clip_id, isolation_id, root)
    recipe = request_recipe(context, baseten_api_key())
    path = clip_dir(clip_id, root) / "isolations" / isolation_id / "recipe.json"
    temporary_path = path.with_suffix(".json.tmp")
    temporary_path.write_text(json.dumps(recipe), encoding="utf-8")
    temporary_path.replace(path)
    LOGGER.info("wrote recipe for clip=%s isolation=%s", clip_id, isolation_id)
    return recipe


@app.function(
    image=analyze_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    secrets=[BASETEN_SECRET],
    timeout=RECIPE_TIMEOUT_SECONDS,
    gpu=None,
)
def recipe_worker(clip_id: str, isolation_id: str) -> None:
    """Build the optional partner-hosted recipe without reserving a GPU."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        write_recipe(clip_id, isolation_id)
    except Exception:
        # The isolated WAV and its notes remain usable when partner inference is unavailable.
        LOGGER.exception("recipe failed for clip=%s isolation=%s", clip_id, isolation_id)
    finally:
        CACHE_VOLUME.commit()
