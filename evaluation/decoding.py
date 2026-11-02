"""Basic Pitch activations to notes, the same way `engine/transcribe.py` asks for them."""

from __future__ import annotations

from pathlib import Path

import numpy as np

# Basic Pitch lives in its own environment, because of TensorFlow, and has no stubs.
from basic_pitch import ICASSP_2022_MODEL_PATH  # type: ignore[import-not-found]
from basic_pitch.constants import AUDIO_SAMPLE_RATE, FFT_HOP  # type: ignore[import-not-found]
from basic_pitch.inference import Model, predict  # type: ignore[import-not-found]
from basic_pitch.note_creation import model_output_to_notes  # type: ignore[import-not-found]
from numpy.typing import NDArray
from scoring import DecoderSettings, Note

FRAMES_PER_SECOND = AUDIO_SAMPLE_RATE / FFT_HOP

Activations = dict[str, NDArray[np.float32]]


def load_model() -> Model:
    return Model(ICASSP_2022_MODEL_PATH)


def activations_for(path: Path, model: Model) -> Activations:
    output: Activations = predict(path, model)[0]
    return output


def decode(activations: Activations, settings: DecoderSettings) -> list[Note]:
    _, events = model_output_to_notes(
        activations,
        onset_thresh=settings.onset_threshold,
        frame_thresh=settings.frame_threshold,
        min_note_len=round(settings.minimum_note_milliseconds / 1000 * FRAMES_PER_SECOND),
        include_pitch_bends=False,
        melodia_trick=settings.melodia_trick,
    )
    return [(float(event[0]), float(event[1]), float(event[2])) for event in events]
