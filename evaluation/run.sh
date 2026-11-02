#!/usr/bin/env bash
# Usage: run.sh <work dir> <results dir>, after setup.sh. About 15 minutes on a Colab T4.
set -euo pipefail

WORK="$1"
RESULTS="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"
NOTES="$WORK/env_notes/bin/python"
SALAMANDER="$(find "$WORK" -name '*.sf2' -not -path '*/env_*' | head -n 1)"
GENERAL_MIDI="/usr/share/sounds/sf2/FluidR3_GM.sf2"

"$NOTES" "$HERE/piano_build.py" --work "$WORK" --salamander "$SALAMANDER" --general-midi "$GENERAL_MIDI"
mkdir -p "$WORK/stems" "$RESULTS"
cd "$WORK"
"$WORK/env_demucs/bin/python" -m demucs -n htdemucs_6s --out stems mixes/*__band.wav mixes/*__steam.wav
echo DEMUCS_DONE
"$NOTES" "$HERE/piano_eval.py" --work "$WORK" --out "$RESULTS/piano.json"
"$NOTES" "$HERE/guitar_eval.py" --audio "$WORK/guitarset/audio_mono-mic" \
  --annotations "$WORK/guitarset/annotation" --work "$WORK" --out "$RESULTS/guitar.json"
echo ALL_DONE
