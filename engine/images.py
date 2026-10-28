"""Container images, one per role: SAM Audio, Demucs and Basic Pitch pin conflicting numpy/protobuf
versions, so each heavy model gets its own image. Model dependencies land with their milestone."""

import modal

PYTHON_VERSION = "3.11"
FFMPEG_PACKAGE = "ffmpeg"

# sam-audio leaves these four dependencies unpinned, so each is pinned to a commit. The install
# order and the final pins come from SPEC.md §7: installing the chain walks numpy and protobuf
# around, so the versions are settled last. A debian_slim base has no TensorFlow or jax, which is
# what made this fight unwinnable on Colab.
SAM_AUDIO_COMMIT = "bb4c6999d2677c7402360e426afc01ddfad6dce0"
DACVAE_COMMIT = "414c20785fc3a28373073ea8ef7a1316eeeaca6e"
IMAGEBIND_COMMIT = "53680b02d7e37b19b124fa37bae4b6c98c38f5be"
CLAP_COMMIT = "b85cb7ecac0af7d064cbf03ebd990e709e959fe7"
PERCEPTION_COMMIT = "e72b6810b1133e1c879f2cc965d276eb73803f1f"

NUMPY_PIN = "numpy==1.26.4"
TRANSFORMERS_PIN = "transformers==4.57.1"
HUGGINGFACE_HUB_PIN = "huggingface_hub==0.36.2"
# `descript-audiotools` drags protobuf down to 3.19.6, which has no `EnumTypeWrapper.ValueType`.
# Modal's own client inside the container needs it and crashes on import without it, even though
# modal declares `protobuf>=3.19`. 3.20.3 is the smallest version that has it and still generates
# 3.x-compatible code, so the old `_pb2.py` files in the audio stack keep working. The only thing
# that wanted `<3.20` is tensorboard logging during training, which we never run.
PROTOBUF_PIN = "protobuf==3.20.3"


def media_image() -> modal.Image:
    """Base for every audio stage: Python plus ffmpeg for decoding."""
    return modal.Image.debian_slim(python_version=PYTHON_VERSION).apt_install(FFMPEG_PACKAGE)


def _git_spec(name: str, repo: str, commit: str) -> str:
    return f"{name} @ git+https://github.com/{repo}.git@{commit}"


web_image = media_image().uv_sync().add_local_python_source("images", "ingest", "isolate", "web")

sam_audio_image = (
    media_image()
    .apt_install("git")
    .pip_install("huggingface_hub<1.0")
    .pip_install(_git_spec("dacvae", "facebookresearch/dacvae", DACVAE_COMMIT))
    .pip_install(_git_spec("imagebind", "facebookresearch/ImageBind", IMAGEBIND_COMMIT))
    .pip_install(_git_spec("laion-clap", "lematt1991/CLAP", CLAP_COMMIT))
    .pip_install(
        f"perception-models @ git+https://github.com/facebookresearch/perception_models@{PERCEPTION_COMMIT}"
    )
    .pip_install(_git_spec("sam-audio", "facebookresearch/sam-audio", SAM_AUDIO_COMMIT))
    .pip_install(NUMPY_PIN, TRANSFORMERS_PIN, HUGGINGFACE_HUB_PIN, PROTOBUF_PIN)
    .add_local_python_source("images", "ingest", "isolate", "web")
)

# `analyze` is pure signal processing: no model, no GPU. Its dependencies come from the `analyze`
# group in pyproject.toml so the librosa pin lives in exactly one place, and it gets its own image
# so the API container does not pay librosa's import cost on every cold start.
analyze_image = (
    media_image().uv_sync(groups=["analyze"]).add_local_python_source("images", "ingest", "analyze")
)

demucs_image = media_image()
basic_pitch_image = media_image()
