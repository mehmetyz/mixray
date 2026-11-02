# Checked again on Nov 2, 2026

## SAM Audio run again

On a Colab A100 40 GB, with the original cells, the same checkpoint revision and the same seeds. New audio
was written beside the old, and scored from it.

| | Demucs | first | CLAP | Judge | paper | oracle |
|---|---:|---:|---:|---:|---:|---:|
| All ten, Nov 1 | 0.547 | 0.281 | 0.440 | 0.479 | 0.474 | 0.495 |
| All ten, Nov 2 | 0.547 | 0.281 | **0.450** | 0.479 | **0.477** | 0.495 |
| Vocals, bass, guitar, n=7, Nov 1 | 0.710 | 0.400 | 0.629 | 0.685 | 0.678 | 0.698 |
| Vocals, bass, guitar, n=7, Nov 2 | 0.710 | 0.400 | **0.641** | 0.685 | **0.682** | 0.698 |

Note agreement with the clean stem. "Paper" is 5 CLAP + 1 Judge; "oracle" is not available at runtime. With
fixed seeds the draws came out the same, so every figure that depends only on them repeats. CLAP moved
because it scores one random 10 s crop. The product uses Judge. Wrong source, all ten, Judge: 4.

| case | prompt | Demucs | first | Judge | oracle |
|---|---|---:|---:|---:|---:|
| nice_guy_vox | lead vocals | 0.659 | 0.806 | 0.782 | 0.806 |
| nice_guy_solo | lead electric guitar | 0.847 | 0.219 | 0.797 | 0.797 |
| karma_piano | piano | 0.460 | 0.124 | 0.114 | 0.133 |
| karma_acoustic | acoustic guitar | 0.743 | 0.090 | 0.751 | 0.751 |
| evening_organ | organ | 0.268 | 0.013 | 0.000 | 0.045 |
| evening_bass | bass guitar | 0.732 | 0.766 | 0.795 | 0.795 |
| summer_acoustic | acoustic guitar | 0.817 | 0.793 | 0.811 | 0.819 |
| summer_synth | synthesizer | 0.135 | 0.000 | 0.000 | 0.008 |
| mend_cello | cello | 0.101 | 0.000 | 0.000 | 0.015 |
| mend_vox | lead vocals | 0.711 | 0.000 | 0.742 | 0.785 |

## Re-scored from stored outputs

On a Colab CPU runtime. Stored separated audio was decoded by Basic Pitch and scored again by the original
cells, with no new separation. Each figure matches what the cells printed on Nov 1.

- **First comparison, 16 targets:** mix 0.271, one SAM Audio draw 0.388, Demucs 0.532. The cross-check
  selector reaches 0.537 and makes five cases worse.
- **"Not found" gate, 120 stems:** absent stems sit from −46.4 to −37.0 dB under the mix. A bar at −25 dB
  catches 31 of 31 absent stems and flags 8 of 89 present ones; −20 dB flags 14 of 89.
- **Solo guitar, 12 recordings, against published labels:** raw 0.870, Demucs 0.868, SAM Audio 0.183.

## Run again from the plain scripts

Piano and guitar decoding on a Colab T4: `piano.json` and `guitar.json`.
