# Evaluation

How the figures in the main [README](../README.md) were measured. The calculations and experiments that
were scattered across Colab notebooks are organised here. They were made between Oct 27 and Nov 2, 2026.
No audio, MIDI or dataset is stored in this folder, and [CREDITS.md](../CREDITS.md) lists the data with its
licences.

## What is here

| Path | What it is |
|---|---|
| `notebooks/` | The Colab work by topic, with its printed output |
| `results/` | What the Nov 2 runs produced: `piano.json`, `guitar.json`, `replay.md` |
| `scoring.py` | Note F1 (50 ms, 50 cents, `mir_eval`) and SI-SDR, unit-tested in CI by `engine/tests/test_evaluation_scoring.py` |
| `piano_build.py`, `piano_eval.py`, `guitar_eval.py`, `decoding.py`, `setup.sh`, `run.sh` | Piano and guitar decoding as plain scripts, which anyone can repeat |

### Notebooks

| Notebook | Question |
|---|---|
| `00_first_lab` | The first setup: environments, the diagnostic worker and the first runs |
| `01_separation_sam_audio_vs_demucs` | Which separator should serve which sound? |
| `02_note_decoding` | How accurate are notes on clean audio, and which settings help? |
| `03_not_found_gate` | When to answer that a sound is not in the clip? |
| `04_drum_hits` | Could drum hits go to a keyboard's pads? |
| `05_muse_spark_as_a_gate` | Can Muse Spark judge a separated sound? |

The data used here: AlbumDB, GuitarSet, and public-domain scores rendered with the Salamander piano.

### How each result was checked again on Nov 2

| Check | What it covers | Outcome |
|---|---|---|
| **Run again**, Colab T4 | Piano and guitar decoding, from the plain scripts | Same settings chosen; figures within 0.006 |
| **Run again**, Colab A100 | Eight SAM Audio draws on the holdout | Same figures with the same seeds, except CLAP |
| **Re-scored** from stored audio, CPU | First comparison, cross-check, "not found" gate, solo guitar | Same figures |
| **Not repeated** | Drum hits, Muse Spark gate, cost | As printed in the notebooks |

## Run it

The piano and guitar measurements repeat in full. They need [uv](https://docs.astral.sh/uv/), a Debian or
Ubuntu system for the packages in `setup.sh`, about 12 GB of disk and preferably a GPU. A Colab T4 works.

```bash
bash evaluation/setup.sh /tmp/mixray-eval
bash evaluation/run.sh /tmp/mixray-eval evaluation/results
```

Demucs and Basic Pitch need conflicting packages, so `setup.sh` makes one environment for each. Nothing here
calls a Meta model or uses Modal credits. The separation runs need a GPU with about 40 GB of memory and a
private Drive folder of stored outputs, so they cannot be repeated from this repository alone.

## How to read the results

- **The split is by design.** Piano settings are chosen on the develop pieces only. Each test piece is scored
  once with the old default and once with the chosen settings. GuitarSet is split by player, so nobody
  appears on both sides.
- **`matches_engine` in `piano.json`** says whether this run chose the settings the engine ships. The engine's
  settings are pinned in `scoring.py`, and a test compares them with `engine/transcribe.py`.
- **Rendered piano is easier than a real recording.** The backing is a simple bass and drum pattern.

## What each measurement changed

Note F1 is against published labels, note agreement is against notes read from the clean stem, and dB is
SI-SDR gain over the mixture.

### Kept in the product

| Change | Data | Before → after |
|---|---|---|
| Stop damaging a solo recording | GuitarSet, 12 recordings, whole chain | SI-SDR +1.5 → +63 dB, note F1 0.532 → 0.673, worst piece 0.000 → 0.536 |
| SAM Audio `small` → `large` | Meta's published table | Music 4.11 → 4.22, instruments 4.24 → 4.49 |
| Eight draws ranked by Judge, not one | AlbumDB, 10 unseen targets | Note agreement 0.281 → 0.479 |
| Send organ, synth and strings to Demucs `other` | AlbumDB, 4 targets | Note agreement SAM Audio 0.009, mix 0.036, Demucs 0.134; still too low to claim notes, so none are shown |
| Level gate for absent sounds | AlbumDB, 120 stems | 31 of 31 absent stems caught |
| Longer minimum note for guitar | GuitarSet, 180 unseen recordings | Note F1 0.732 → 0.777 |
| Stricter decoding for piano | Mutopia and Salamander, 10 unseen pieces | Note F1 0.684 → 0.757 in a band |
| Three note-deleting filters reverted | Hand-built note lists | Sustained melody 1 → 5 of 5 notes, sixteenth run 8 → 16 of 16 |
| Remove low bleed from piano | Our own synthesised test pieces, an upper bound | Note F1 0.620 → 0.897 |
| Draws run one at a time, 3 → 8 | Our own synthesised test piece | One draw gave +8.02, −0.16 and +8.20 dB on one clip, so a single draw is a sample |

### Tried and dropped

| Idea | Data | Result |
|---|---|---|
| Cross-check SAM Audio against Demucs | AlbumDB, 16 cases | +0.005 agreement, 5 cases worse |
| Demucs first, then SAM Audio | AlbumDB | 0.049 against Demucs alone at 0.155 |
| `htdemucs_ft` | AlbumDB, 10 each | Vocals 0.784 → 0.797, bass 0.699 → 0.708, for about 58 s per clip |
| Muse Spark judging audio | AlbumDB stems, 388 calls | Rejected 13 of 13 wrong outputs and 0 of 8 right ones, but 18 of 125 clips stayed undecided; used to name images and write text instead |
