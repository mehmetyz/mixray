"""Container images, one per role: SAM Audio, Demucs and Basic Pitch pin conflicting numpy/protobuf
versions, so each heavy model gets its own image. Model dependencies land with their milestone."""

import modal

PYTHON_VERSION = "3.11"
FFMPEG_PACKAGE = "ffmpeg"


def media_image() -> modal.Image:
    """Base for every audio stage: Python plus ffmpeg for decoding."""
    return modal.Image.debian_slim(python_version=PYTHON_VERSION).apt_install(FFMPEG_PACKAGE)


web_image = (
    modal.Image.debian_slim(python_version=PYTHON_VERSION).uv_sync().add_local_python_source("web")
)
sam_audio_image = media_image()
demucs_image = media_image()
basic_pitch_image = media_image()
