"""Decide which separator serves a prompt, and serve the prompts that belong to Demucs.

Measured on one album's real stems. Vocals, bass and guitar go to SAM Audio with eight ranked
candidates (note agreement 0.68 against Demucs' 0.71 on seven unseen targets). Piano and other
pitched instruments go to Demucs (on Karma's piano 0.46 against 0.13 for SAM Audio's best draw).
Sound events go to SAM Audio with span prediction, which reached +18 to +20 dB where Demucs has no
matching stem. A solo recording skips separation, because Demucs cost solo piano 0.136 of real-label
note F1.
"""

from __future__ import annotations

import audioop
import json
import logging
import math
import re
import subprocess
import sys
import wave
from pathlib import Path
from typing import TYPE_CHECKING, Literal, TypedDict

import modal

from images import demucs_image
from ingest import IsolationEntry, IsolationMethod, clip_dir, encode_mp3, get_cache_root
from isolate import SoundNotFoundError, cached_isolation, persist_isolation

if TYPE_CHECKING:
    import torch

LOGGER = logging.getLogger(__name__)

app = modal.App("mixray-fallback")

FALLBACK_TIMEOUT_SECONDS = 900
DEMUCS_COMMAND_TIMEOUT_SECONDS = 840
DEMUCS_MODEL = "htdemucs_6s"
DEMUCS_DEVICE = "cpu"
FALLBACK_DIRECTORY_NAME = "fallback"
WAV_EXTENSION = ".wav"
MP3_EXTENSION = ".mp3"
PCM16_SAMPLE_WIDTH = 2
PCM16_FULL_SCALE = 32768.0
# A Demucs piano stem at -18 dB or above averaged note agreement 0.475 over 19 of 48 controlled
# mixes. Between -25 and -18 dB the average fell to 0.34, too low to teach.
PIANO_STEM_LEVEL_DB = -18.0
# No vocals, drums or bass, and one stem holding nearly everything. All 12 duets pass the first test
# alone, so the second keeps them out: 0 of 12 duets and 20 of 34 solos pass. A missed solo takes
# the normal Demucs path, which is lower quality but never serves two instruments as one.
SOLO_MAX_BAND_SHARE = 0.30
SOLO_MIN_TOP_SHARE = 0.92
BAND_STEMS: StemNames = ("vocals", "drums", "bass")
SAM_CANDIDATE_STEMS: frozenset[StemName] = frozenset({"vocals", "bass", "guitar"})
NOTE_STEMS: frozenset[StemName] = frozenset({"vocals", "bass", "guitar", "piano"})
# Speech reads as vocals, but SAM Audio measured -14 dB on it where the Demucs stem held +1.7 dB.
SPEECH_WORDS = frozenset({"speech", "speaking", "speak", "talking", "talk", "spoken", "narration"})
# Across 120 stems from 20 mixtures, every one of the 31 instruments absent from its mixture landed
# between -46.4 and -37.0 dB under it, while 81 of 89 present stems stayed above -25 dB. The eight
# present stems below the bar were all unusable anyway: two were a piano Demucs never found, whose
# notes scored 0.015 and 0.076. So this separates "nothing to serve" from "something to serve".
ABSENT_STEM_LEVEL_DB = -25.0

StemName = Literal["vocals", "drums", "bass", "guitar", "piano", "other"]
StemNames = tuple[StemName, ...]
StemKeywordMatch = tuple[StemName, frozenset[str]]
StemKeywordMatches = tuple[StemKeywordMatch, ...]
StemRms = dict[StemName, float]
IsolationRoute = Literal["sam_candidates", "sam_event", "demucs"]
FallbackStems = list["FallbackStem"]

# Keep this order aligned with the schema's StemName enum and the htdemucs_6s source names.
STEM_NAMES: StemNames = ("vocals", "drums", "bass", "guitar", "piano", "other")
# `other` carries every pitched instrument the five named stems do not. Reaching it measured note
# F1 0.134 across organ, cello and two synth parts against 0.036 for the raw mixture and 0.009 for
# SAM Audio, so it earns those prompts even though 0.134 is far from teachable on its own.
# `keys` and `keyboard` are deliberately absent from `piano`: a synth part reached through them
# scored 0.005 from the piano stem against 0.135 from `other`.
PROMPT_STEM_KEYWORDS: StemKeywordMatches = (
    (
        "vocals",
        frozenset({"vocal", "vocals", "voice", "sing", "singing", "singer"}) | SPEECH_WORDS,
    ),
    ("drums", frozenset({"drum", "drums", "kick", "snare", "hihat", "hat", "cymbal"})),
    ("bass", frozenset({"bass", "sub", "subbass"})),
    ("guitar", frozenset({"guitar", "guitars", "ukulele", "ukelele", "banjo"})),
    ("piano", frozenset({"piano", "pianos"})),
    (
        "other",
        frozenset(
            {
                "synth",
                "synthesiser",
                "synthesizer",
                "pad",
                "lead",
                "supersaw",
                "pluck",
                "organ",
                "rhodes",
                "wurlitzer",
                "harpsichord",
                "accordion",
                "keys",
                "keyboard",
                "string",
                "strings",
                "cello",
                "violin",
                "viola",
                "harp",
                "brass",
                "horn",
                "horns",
                "trumpet",
                "trombone",
                "sax",
                "saxophone",
                "flute",
                "clarinet",
                "oboe",
                "woodwind",
            }
        ),
    ),
)
PROMPT_TOKEN_PATTERN = re.compile(r"[a-z]+")
# Sounds whose names contain an instrument word. Matched as whole phrases before the keywords above.
EVENT_PHRASES = (" car horn ", " vehicle horn ")


class FallbackStem(TypedDict):
    """One cached Demucs alternative, matching the schema's FallbackStem object."""

    name: StemName
    url: str
    wav_url: str
    level: float


def stem_for_prompt(prompt: str) -> StemName | None:
    """Return the standard Demucs stem named by a natural-language prompt, if any."""
    words = PROMPT_TOKEN_PATTERN.findall(prompt.lower())
    phrase = f" {' '.join(words)} "
    if any(event in phrase for event in EVENT_PHRASES):
        return None
    prompt_tokens = frozenset(words)
    for stem, keywords in PROMPT_STEM_KEYWORDS:
        if prompt_tokens.intersection(keywords):
            return stem
    return None


def _is_speech(prompt: str) -> bool:
    return bool(frozenset(PROMPT_TOKEN_PATTERN.findall(prompt.lower())) & SPEECH_WORDS)


def route_for_prompt(prompt: str) -> IsolationRoute:
    """Name the separator measured best for what this prompt asks for."""
    stem = stem_for_prompt(prompt)
    if stem is None:
        return "sam_event"
    if stem in SAM_CANDIDATE_STEMS and not _is_speech(prompt):
        return "sam_candidates"
    return "demucs"


def prompt_has_notes(prompt: str) -> bool:
    """Whether Mixray claims notes for this sound: other pitched stems measured only 0.13."""
    return stem_for_prompt(prompt) in NOTE_STEMS and not _is_speech(prompt)


def _fallback_directory(clip_id: str, cache_root: Path) -> Path:
    return clip_dir(clip_id, cache_root) / FALLBACK_DIRECTORY_NAME / DEMUCS_MODEL


def _stem_wav_path(clip_id: str, stem: StemName, cache_root: Path) -> Path:
    return _fallback_directory(clip_id, cache_root) / f"{stem}{WAV_EXTENSION}"


def _stem_mp3_path(clip_id: str, stem: StemName, cache_root: Path) -> Path:
    return _fallback_directory(clip_id, cache_root) / f"{stem}{MP3_EXTENSION}"


def _stem_url(clip_id: str, stem: StemName, extension: str) -> str:
    return f"/files/clips/{clip_id}/{FALLBACK_DIRECTORY_NAME}/{DEMUCS_MODEL}/{stem}{extension}"


def _all_wavs_exist(clip_id: str, cache_root: Path) -> bool:
    return all(_stem_wav_path(clip_id, stem, cache_root).exists() for stem in STEM_NAMES)


def _run_demucs(clip_id: str, cache_root: Path) -> None:
    """Run the six-source model once unless every cached WAV stem is already present."""
    if _all_wavs_exist(clip_id, cache_root):
        return

    mix_wav = clip_dir(clip_id, cache_root) / "mix.wav"
    if not mix_wav.exists():
        raise FileNotFoundError(f"no mix for clip {clip_id}: {mix_wav}")

    output_root = _fallback_directory(clip_id, cache_root).parent
    output_root.mkdir(parents=True, exist_ok=True)
    # htdemucs_6s is the six-source model: the ordinary htdemucs model omits piano and guitar.
    argv = [
        sys.executable,
        "-m",
        "demucs.separate",
        "--name",
        DEMUCS_MODEL,
        "--device",
        DEMUCS_DEVICE,
        "--out",
        str(output_root),
        "--filename",
        "{stem}.{ext}",
        str(mix_wav),
    ]
    LOGGER.info("running Demucs fallback for clip=%s", clip_id)
    subprocess.run(argv, check=True, timeout=DEMUCS_COMMAND_TIMEOUT_SECONDS)

    missing_stems = [
        stem for stem in STEM_NAMES if not _stem_wav_path(clip_id, stem, cache_root).exists()
    ]
    if missing_stems:
        missing = ", ".join(missing_stems)
        raise RuntimeError(f"Demucs did not produce stems: {missing}")


def _rms(wav_path: Path) -> float:
    """Return the PCM RMS for a WAV stem, or zero for a silent stem."""
    with wave.open(str(wav_path), "rb") as wav_file:
        frames = wav_file.readframes(wav_file.getnframes())
        sample_width = wav_file.getsampwidth()
    if not frames:
        return 0.0
    return float(audioop.rms(frames, sample_width))


def _normalised_rms(clip_id: str, cache_root: Path) -> StemRms:
    rms_by_stem = {stem: _rms(_stem_wav_path(clip_id, stem, cache_root)) for stem in STEM_NAMES}
    loudest_rms = max(rms_by_stem.values(), default=0.0)
    if loudest_rms <= 0.0:
        return {stem: 0.0 for stem in STEM_NAMES}
    return {
        stem: round(min(1.0, max(0.0, rms / loudest_rms)), 6) for stem, rms in rms_by_stem.items()
    }


def separate_clip(clip_id: str, cache_root: Path | None = None) -> FallbackStems:
    """Separate a clip once, encode each stem for playback, and return schema-valid entries."""
    root = cache_root if cache_root is not None else get_cache_root()
    _run_demucs(clip_id, root)

    for stem in STEM_NAMES:
        wav_path = _stem_wav_path(clip_id, stem, root)
        mp3_path = _stem_mp3_path(clip_id, stem, root)
        if not mp3_path.exists():
            encode_mp3(wav_path, mp3_path)

    levels = _normalised_rms(clip_id, root)
    return [
        {
            "name": stem,
            "url": _stem_url(clip_id, stem, MP3_EXTENSION),
            "wav_url": _stem_url(clip_id, stem, WAV_EXTENSION),
            "level": levels[stem],
        }
        for stem in STEM_NAMES
    ]


def write_fallback_stems(
    clip_id: str, fallback_stems: FallbackStems, cache_root: Path | None = None
) -> None:
    """Write the producer-owned fallback stems sidecar."""
    root = cache_root if cache_root is not None else get_cache_root()
    path = clip_dir(clip_id, root) / "fallback_stems.json"
    tmp_path = path.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(fallback_stems), encoding="utf-8")
    tmp_path.replace(path)


def run_fallback(clip_id: str, cache_root: Path | None = None) -> FallbackStems:
    """Create and persist fallback stems for one clip."""
    fallback_stems = separate_clip(clip_id, cache_root)
    write_fallback_stems(clip_id, fallback_stems, cache_root)
    LOGGER.info("cached %d Demucs fallback stems for clip=%s", len(fallback_stems), clip_id)
    return fallback_stems


def _read_mono(path: Path) -> tuple[int, torch.Tensor]:
    """Read one 16-bit PCM WAV as a mono float waveform."""
    import torch

    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        if wav_file.getsampwidth() != PCM16_SAMPLE_WIDTH:
            raise RuntimeError(f"{path.name} is not 16-bit PCM")
        rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())
    interleaved = torch.frombuffer(bytearray(frames), dtype=torch.int16).float()
    # Reshaping before the mean keeps the channels apart; a flat view would interleave them.
    return rate, interleaved.view(-1, channels).mean(dim=1) / PCM16_FULL_SCALE


def _level_against_db(waveform: torch.Tensor, reference: torch.Tensor) -> float:
    """Return how far a waveform sits under a reference in decibels, by RMS."""

    def rms(signal: torch.Tensor) -> float:
        return max(float(signal.pow(2).mean().sqrt()), 1e-12)

    return 20.0 * math.log10(rms(waveform) / rms(reference))


def _stem_waveforms(clip_id: str, cache_root: Path) -> tuple[int, dict[StemName, torch.Tensor]]:
    """Read every cached stem as a mono float waveform, so one can be served and the rest summed."""
    sample_rate = 0
    waveforms: dict[StemName, torch.Tensor] = {}
    for stem in STEM_NAMES:
        rate, waveform = _read_mono(_stem_wav_path(clip_id, stem, cache_root))
        if sample_rate and rate != sample_rate:
            raise RuntimeError("Demucs stems disagree on sample rate")
        sample_rate = rate
        waveforms[stem] = waveform
    return sample_rate, waveforms


def _passes_solo_shares(energies: dict[StemName, float]) -> bool:
    total = max(sum(energies.values()), 1e-20)
    band_share = sum(energies[name] for name in BAND_STEMS) / total
    return band_share < SOLO_MAX_BAND_SHARE and max(energies.values()) / total >= SOLO_MIN_TOP_SHARE


def _is_solo(waveforms: dict[StemName, torch.Tensor]) -> bool:
    """Both tests must pass: plain energy, and energy of the sample-to-sample change.

    Plain energy is dominated by low notes, so a hiss or a clatter over a piano barely counts in it:
    steam over a café piano held 7% of it and the clip passed as a solo, serving the steam as piano.
    The change in each sample weights high frequencies the way the ear does; there the same steam
    held 38%, while Demucs had put it in the drums stem and left the piano stem 20 dB quieter.
    """
    plain = {name: float(waveform.pow(2).mean()) for name, waveform in waveforms.items()}
    bright = {name: float(waveform.diff().pow(2).mean()) for name, waveform in waveforms.items()}
    return _passes_solo_shares(plain) and _passes_solo_shares(bright)


def run_routed_isolation(  # noqa: PLR0913
    clip_id: str,
    iso_id: str,
    prompt: str,
    label: str,
    *,
    sam_allowed: bool = True,
    cache_root: Path | None = None,
) -> IsolationEntry | None:
    """Serve a named instrument, or return None when it is present and belongs to SAM Audio."""
    stem = stem_for_prompt(prompt)
    if stem is None:
        raise ValueError(f"prompt names no standard Demucs stem: {prompt}")
    root = cache_root if cache_root is not None else get_cache_root()
    iso_dir, cached_json, trackmap_url, cached = cached_isolation(clip_id, iso_id, root)
    if cached is not None:
        return cached

    run_fallback(clip_id, root)
    sample_rate, waveforms = _stem_waveforms(clip_id, root)
    mix_rate, mixture = _read_mono(clip_dir(clip_id, root) / "mix.wav")
    method: IsolationMethod = "demucs"
    sound, rest, rate = waveforms[stem], None, sample_rate
    if stem not in BAND_STEMS and _is_solo(waveforms):
        LOGGER.info("clip=%s is a solo recording; serving it unseparated", clip_id)
        method, sound, rest, rate = (
            "unseparated",
            mixture,
            mixture.new_zeros(mixture.shape),
            mix_rate,
        )
    else:
        level = _level_against_db(sound, mixture)
        bar = PIANO_STEM_LEVEL_DB if stem == "piano" else ABSENT_STEM_LEVEL_DB
        if level < bar:
            LOGGER.info("stem=%s sits %.1f dB under clip=%s; refusing it", stem, level, clip_id)
            raise SoundNotFoundError(stem)
        if sam_allowed and route_for_prompt(prompt) == "sam_candidates":
            return None
    if rest is None:
        rest = sum(
            (waveform for name, waveform in waveforms.items() if name != stem),
            start=sound.new_zeros(sound.shape),
        )
    LOGGER.info("serving %s for clip=%s prompt=%s", method, clip_id, prompt)
    return persist_isolation(
        clip_id,
        iso_id,
        label=label,
        prompt=prompt,
        method=method,
        sound=sound,
        rest=rest,
        sample_rate=rate,
        cache_root=root,
        iso_dir=iso_dir,
        cached_json=cached_json,
        trackmap_url=trackmap_url,
    )


# A 30-second clip separates acceptably on CPU, avoiding a GPU reservation for this optional path.
@app.function(image=demucs_image, timeout=FALLBACK_TIMEOUT_SECONDS, gpu=None)
def fallback_clip(clip_id: str) -> FallbackStems:
    """Modal entrypoint for generating a clip's cached Demucs alternatives."""
    logging.basicConfig(level=logging.INFO)
    return run_fallback(clip_id)
