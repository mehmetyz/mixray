"""Build labelled piano mixes: public-domain MIDI, sampled piano, a generated band and hiss."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
import pretty_midi
import soundfile as sf
from numpy.typing import NDArray

SAMPLE_RATE = 44_100
CLIP_SECONDS = 30.0
MUTOPIA_FILES = "https://www.mutopiaproject.org/ftp/"
PIANO_LEVEL = 0.1
BAND_UNDER_PIANO_DB = -2.0
STEAM_UNDER_PIANO_DB = -6.0
STEAM_CUTOFF_HZ = 3000.0
STEAM_STARTS_SECONDS = (4.0, 13.0, 22.0)
STEAM_BURST_SECONDS = 4.0
FULL_SCALE = 0.9
ACOUSTIC_BASS_PROGRAM = 33
BASS_LOWEST_PITCH = 31
BASS_HIGHEST_PITCH = 52
MINIMUM_VELOCITY = 50
LICENCE_PATTERN = re.compile(r"<mp:licence>([^<]+)</mp:licence>")
HTTP_TIMEOUT_SECONDS = 60

# Solo piano, alternating per composer, fixed before any result existed.
DEVELOP = (
    "ChopinFF/O10/10-02-i/10-02-i",
    "ChopinFF/O10/chp-10-05/chp-10-05",
    "JoplinS/EliteSyncopations/EliteSyncopations",
    "JoplinS/SomethingDoing/SomethingDoing",
    "BeethovenLv/O2/LVB_Sonate_02no1_1/LVB_Sonate_02no1_1",
    "BeethovenLv/O10/LVB_Sonate_10no1_1/LVB_Sonate_10no1_1",
    "MozartWA/KV309/KV309_1/KV309_1",
    "DebussyC/L66/debussy_Arabesque_1/debussy_Arabesque_1",
    "SchumannR/O15/SchumannOp15No01/SchumannOp15No01",
    "GriegE/O46/02-lamortdase/02-lamortdase",
)
TEST = (
    "ChopinFF/O10/chopin-op-10-09-wfi/chopin-op-10-09-wfi",
    "ChopinFF/B130/TroisNouvellesEtudes_Chopin_n1/TroisNouvellesEtudes_Chopin_n1",
    "JoplinS/PineappleRag/PineappleRag",
    "JoplinS/WallStreetRag/WallStreetRag",
    "BeethovenLv/O2/LVB_Sonate_02no1_3/LVB_Sonate_02no1_3",
    "BeethovenLv/O10/LVB_Sonate_10no1_3/LVB_Sonate_10no1_3",
    "DebussyC/L75/debussy_Ste_Bergamesq_Clair/debussy_Ste_Bergamesq_Clair",
    "SchumannR/O15/SchumannOp15No07/SchumannOp15No07",
    "GriegE/O54/Troldtog/Troldtog",
    "GriegE/O65/troldhaugen/troldhaugen",
)

Audio = NDArray[np.float64]


def _render(midi: pretty_midi.PrettyMIDI, wav_path: Path, soundfont: Path) -> Audio:
    midi_path = wav_path.with_suffix(".mid")
    midi.write(str(midi_path))
    subprocess.run(
        [
            "fluidsynth",
            "-ni",
            "-q",
            "-g",
            "0.8",
            "-r",
            str(SAMPLE_RATE),
            "-F",
            str(wav_path),
            str(soundfont),
            str(midi_path),
        ],
        check=True,
        capture_output=True,
    )
    samples, _ = sf.read(str(wav_path), dtype="float64")
    mono = samples.mean(axis=1) if samples.ndim > 1 else samples
    clip = np.zeros(int(CLIP_SECONDS * SAMPLE_RATE))
    length = min(mono.size, clip.size)
    clip[:length] = mono[:length]
    return clip


def _rms(samples: Audio) -> float:
    return float(np.sqrt((samples**2).mean()) + 1e-12)


def _steam(name: str) -> Audio:
    # Seeded from the name's digest: Python's own `hash` changes per process, which made this
    # noise differ between runs.
    seed = int.from_bytes(hashlib.sha256(name.encode()).digest()[:4], "big")
    size = int(CLIP_SECONDS * SAMPLE_RATE)
    spectrum = np.fft.rfft(np.random.default_rng(seed).standard_normal(size))
    spectrum[np.fft.rfftfreq(size, 1 / SAMPLE_RATE) < STEAM_CUTOFF_HZ] = 0
    hiss = np.fft.irfft(spectrum, size)
    envelope = np.zeros(size)
    for start in STEAM_STARTS_SECONDS:
        envelope[int(start * SAMPLE_RATE) : int((start + STEAM_BURST_SECONDS) * SAMPLE_RATE)] = 1.0
    return hiss * envelope


def _piano_part(source: pretty_midi.PrettyMIDI) -> tuple[pretty_midi.Instrument, float]:
    notes = sorted(
        (note for part in source.instruments if not part.is_drum for note in part.notes),
        key=lambda note: note.start,
    )
    first = notes[0].start
    piano = pretty_midi.Instrument(program=0)
    for note in notes:
        if note.start - first < CLIP_SECONDS - 0.5:
            piano.notes.append(
                pretty_midi.Note(
                    velocity=max(note.velocity, MINIMUM_VELOCITY),
                    pitch=note.pitch,
                    start=note.start - first,
                    end=min(note.end - first, CLIP_SECONDS),
                )
            )
    return piano, first


def _backing(beats: list[float], piano: pretty_midi.Instrument) -> pretty_midi.PrettyMIDI:
    """The lowest piano note per beat as a bass line, over a plain drum pattern."""
    bass = pretty_midi.Instrument(program=ACOUSTIC_BASS_PROGRAM)
    drums = pretty_midi.Instrument(program=0, is_drum=True)
    for index, beat in enumerate(beats):
        end = beats[index + 1] if index + 1 < len(beats) else beat + 0.5
        sounding = [note.pitch for note in piano.notes if beat <= note.start < end]
        if sounding:
            pitch = min(sounding)
            while pitch > BASS_HIGHEST_PITCH:
                pitch -= 12
            while pitch < BASS_LOWEST_PITCH:
                pitch += 12
            bass.notes.append(
                pretty_midi.Note(
                    velocity=95, pitch=pitch, start=beat, end=max(end - 0.02, beat + 0.05)
                )
            )
        kick_or_snare = 36 if index % 2 == 0 else 38
        drums.notes.append(
            pretty_midi.Note(velocity=100, pitch=kick_or_snare, start=beat, end=beat + 0.1)
        )
        drums.notes.append(pretty_midi.Note(velocity=70, pitch=42, start=beat, end=beat + 0.05))
        half = (beat + end) / 2
        drums.notes.append(pretty_midi.Note(velocity=60, pitch=42, start=half, end=half + 0.05))
    backing = pretty_midi.PrettyMIDI()
    backing.instruments += [bass, drums]
    return backing


def _licence(relative: str) -> str:
    """What Mutopia's own record for the piece declares."""
    try:
        with urllib.request.urlopen(
            f"{MUTOPIA_FILES}{relative}.rdf", timeout=HTTP_TIMEOUT_SECONDS
        ) as response:
            found = LICENCE_PATTERN.search(response.read().decode("utf-8", errors="replace"))
    except urllib.error.URLError:
        return "not read"
    return found.group(1) if found is not None else "not read"


def _write_conditions(name: str, piano: Audio, backing: Audio, out: Path) -> None:
    piano = piano / _rms(piano) * PIANO_LEVEL
    band = backing / _rms(backing) * PIANO_LEVEL * 10 ** (BAND_UNDER_PIANO_DB / 20)
    hiss = _steam(name)
    hiss = hiss / _rms(hiss[hiss != 0]) * PIANO_LEVEL * 10 ** (STEAM_UNDER_PIANO_DB / 20)
    for condition, mix in (("solo", piano), ("band", piano + band), ("steam", piano + hiss)):
        peak = max(float(np.abs(mix).max()), 1e-6)
        scaled = mix / peak * FULL_SCALE if peak > FULL_SCALE else mix
        sf.write(str(out / f"{name}__{condition}.wav"), scaled.astype(np.float32), SAMPLE_RATE)


def build_piece(
    relative: str, split: str, root: Path, salamander: Path, general_midi: Path
) -> dict[str, object]:
    name = relative.rsplit("/", maxsplit=1)[-1]
    midi_path = root / "midi" / f"{name}.mid"
    if not midi_path.exists():
        urllib.request.urlretrieve(f"{MUTOPIA_FILES}{relative}.mid", midi_path)
    source = pretty_midi.PrettyMIDI(str(midi_path))
    part, first = _piano_part(source)
    piano = pretty_midi.PrettyMIDI()
    piano.instruments.append(part)
    beats = [beat - first for beat in source.get_beats() if 0 <= beat - first < CLIP_SECONDS]

    mixes = root / "mixes"
    rendered = _render(piano, mixes / f"{name}__piano.wav", salamander)
    backing = _render(_backing(beats, part), mixes / f"{name}__backing.wav", general_midi)
    _write_conditions(name, rendered, backing, mixes)
    return {
        "split": split,
        "source": f"{MUTOPIA_FILES}{relative}.mid",
        "licence": _licence(relative),
        "notes": [[note.start, note.end, note.pitch] for note in part.notes],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--salamander", type=Path, required=True, help="Salamander V3 .sf2")
    parser.add_argument("--general-midi", type=Path, required=True, help="FluidR3 GM .sf2")
    arguments = parser.parse_args()

    (arguments.work / "midi").mkdir(parents=True, exist_ok=True)
    (arguments.work / "mixes").mkdir(parents=True, exist_ok=True)
    labels: dict[str, dict[str, object]] = {}
    for split, pieces in (("develop", DEVELOP), ("test", TEST)):
        for relative in pieces:
            name = relative.rsplit("/", maxsplit=1)[-1]
            labels[name] = build_piece(
                relative, split, arguments.work, arguments.salamander, arguments.general_midi
            )
            print(split, name, labels[name]["licence"], flush=True)
    (arguments.work / "labels.json").write_text(json.dumps(labels), encoding="utf-8")
    print("BUILD_DONE", len(labels), flush=True)


if __name__ == "__main__":
    main()
