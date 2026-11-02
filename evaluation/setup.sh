#!/usr/bin/env bash
# Two environments, because Demucs and Basic Pitch pin conflicting numpy and TensorFlow needs.
# Usage: setup.sh <work dir>. Needs uv; the system packages assume Debian or Ubuntu, as on Colab.
set -euo pipefail

WORK="$1"
SALAMANDER_URL="https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPiano-SF2-V3+20200602.tar.xz"
GUITARSET_RECORD="https://zenodo.org/records/3371780/files"

apt-get -qq update
apt-get -qq install -y fluidsynth fluid-soundfont-gm xz-utils unzip

mkdir -p "$WORK/guitarset"
uv venv --python 3.11 --quiet "$WORK/env_demucs"
uv pip install --quiet --python "$WORK/env_demucs/bin/python" \
  torch==2.5.1 torchaudio==2.5.1 demucs==4.1.0 numpy==1.26.4 soundfile==0.13.1
uv venv --python 3.11 --quiet "$WORK/env_notes"
uv pip install --quiet --python "$WORK/env_notes/bin/python" \
  basic-pitch==0.4.0 tensorflow==2.15.0 numpy==1.26.4 setuptools==80.9.0 \
  mir_eval==0.8.2 pretty_midi==0.2.10 soundfile==0.13.1

wget -q -O "$WORK/salamander.tar.xz" "$SALAMANDER_URL"
tar -xJf "$WORK/salamander.tar.xz" -C "$WORK"
rm "$WORK/salamander.tar.xz"

for archive in annotation audio_mono-mic; do
  wget -q -O "$WORK/guitarset/$archive.zip" "$GUITARSET_RECORD/$archive.zip?download=1"
  unzip -o -q "$WORK/guitarset/$archive.zip" -d "$WORK/guitarset/$archive"
  rm "$WORK/guitarset/$archive.zip"
done
echo SETUP_DONE
