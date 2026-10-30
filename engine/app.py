"""Modal application entrypoint for Mixray."""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

import modal

from analyze import apply_analysis
from fallback import run_fallback, stem_for_prompt
from images import analyze_image, basic_pitch_image, demucs_image, sam_audio_image, web_image
from ingest import (
    DEFAULT_CACHE_PATH,
    IngestError,
    cleanup_expired_clips,
    clip_dir,
    get_cache_root,
    isolation_id_for,
    write_job,
)
from isolate import (
    DEFAULT_MODEL_ID,
    HF_SECRET,
    MEASURE_GPU,
    RANKERS_OFF,
    WEIGHTS_PATH,
    WEIGHTS_VOLUME,
    run_isolation,
)
from recipe import write_recipe
from suggest import suggest_clip, write_isolation_summary
from transcribe import apply_transcription

if TYPE_CHECKING:
    from fastapi import FastAPI
    from sam_audio import SAMAudio, SAMAudioProcessor

LOGGER = logging.getLogger(__name__)

WEB_TIMEOUT_SECONDS = 120
ISOLATE_TIMEOUT_SECONDS = 300
ANALYZE_TIMEOUT_SECONDS = 300
TRANSCRIBE_TIMEOUT_SECONDS = 300
FALLBACK_TIMEOUT_SECONDS = 900
RECIPE_TIMEOUT_SECONDS = 180
SUGGEST_TIMEOUT_SECONDS = 300
SUMMARY_TIMEOUT_SECONDS = 120
CLEANUP_TIMEOUT_SECONDS = 300
MAX_ISOLATE_CONTAINERS = 2

CACHE_VOLUME = modal.Volume.from_name("mixray-cache", create_if_missing=True)
API_SECRET = modal.Secret.from_name("mixray-secrets")
# Its own secret, following `mixray-hf`: adding a key to `mixray-secrets` means
# `modal secret create --force`, which replaces the whole secret.
BASETEN_SECRET = modal.Secret.from_name("mixray-baseten")

app = modal.App("mixray")


@app.cls(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME, DEFAULT_CACHE_PATH: CACHE_VOLUME},
    secrets=[HF_SECRET, API_SECRET],
    timeout=ISOLATE_TIMEOUT_SECONDS,
    max_containers=MAX_ISOLATE_CONTAINERS,
    enable_memory_snapshot=True,
)
class IsolationWorker:
    """Keep SAM Audio resident: reload costs 12.1 s or 65.6 s, versus 5.1 s to separate."""

    model: SAMAudio
    processor: SAMAudioProcessor

    @modal.enter(snap=True)
    def load_model_on_cpu(self) -> None:
        """Load CPU weights so Modal can capture the expensive initialization."""
        os.environ["HF_HOME"] = f"{WEIGHTS_PATH}/huggingface"

        from sam_audio import SAMAudio, SAMAudioProcessor

        self.model = SAMAudio.from_pretrained(DEFAULT_MODEL_ID, **RANKERS_OFF)
        self.processor = SAMAudioProcessor.from_pretrained(DEFAULT_MODEL_ID)

    @modal.enter(snap=False)
    def move_model_to_gpu(self) -> None:
        """Transfer weights after restore because GPU state is not part of the memory snapshot."""
        self.model = self.model.eval().cuda()

    def _queue_follow_up(self, clip_id: str, iso_id: str, prompt: str) -> None:
        """Queue optional post-isolation work after a successful isolation."""
        try:
            transcribe_worker.spawn(clip_id, iso_id)
        except Exception:
            LOGGER.exception(
                "could not queue transcription for clip=%s isolation=%s", clip_id, iso_id
            )
        try:
            recipe_worker.spawn(clip_id, iso_id)
        except Exception:
            # Partner inference is an optional Take-home enhancement, never an isolation failure.
            LOGGER.exception("could not queue recipe for clip=%s isolation=%s", clip_id, iso_id)
        if stem_for_prompt(prompt) is not None:
            try:
                fallback_worker.spawn(clip_id)
            except Exception:
                LOGGER.exception("could not queue fallback for clip=%s", clip_id)

    @modal.method()
    def isolate(self, clip_id: str, iso_id: str, prompt: str, label: str) -> None:
        """Run SAM Audio separation on GPU and commit outputs to mixray-cache."""
        logging.basicConfig(level=logging.INFO)
        CACHE_VOLUME.reload()
        try:
            run_isolation(
                clip_id=clip_id,
                iso_id=iso_id,
                prompt=prompt,
                label=label,
                model=self.model,
                processor=self.processor,
            )
        except Exception:
            LOGGER.exception("isolation failed for clip=%s prompt=%s", clip_id, prompt)
            write_job(
                {
                    "id": clip_id,
                    "status": "error",
                    "stage": "error",
                    "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
                    "isolation_id": iso_id,
                    "cached": False,
                    "error": "Audio isolation failed. Please try another prompt.",
                }
            )
        else:
            # The commit has to happen BEFORE the follow-ups are queued. They reload the Volume as
            # they start and read this isolation's `sound.wav`; queued first, they raced the commit
            # and lost it, and because each failure is swallowed as optional the isolation looked
            # fine while every clip arrived with no notes to learn. It only worked earlier because
            # importing TensorFlow took long enough for the commit to land.
            CACHE_VOLUME.commit()
            self._queue_follow_up(clip_id, iso_id, prompt)
        finally:
            CACHE_VOLUME.commit()

    @modal.method()
    def track_and_isolate(self, clip_id: str, x: int, y: int, frame: int) -> None:
        """Track a tap, name a visible mask crop, then separate with SAM Audio text prompting."""
        from label import label_region
        from meta_api import api_key
        from track import TapRequest, label_target, name_track, save_track, track_point

        logging.basicConfig(level=logging.INFO)
        root = get_cache_root()
        directory = clip_dir(clip_id, root)
        CACHE_VOLUME.reload()
        iso_id: str | None = None
        named_prompt: str | None = None
        try:
            write_job(
                {
                    "id": clip_id,
                    "status": "running",
                    "stage": "segmenting",
                    "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
                    "isolation_id": None,
                    "cached": False,
                    "error": None,
                },
                root,
            )
            CACHE_VOLUME.commit()
            tap: TapRequest = {"x": x, "y": y, "frame": frame, "label": "Tapped sound"}
            track = track_point(clip_id, tap, root)
            target = label_target(track, frame, directory)

            write_job(
                {
                    "id": clip_id,
                    "status": "running",
                    "stage": "naming",
                    "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
                    "isolation_id": None,
                    "cached": False,
                    "error": None,
                },
                root,
            )
            CACHE_VOLUME.commit()
            named = label_region(target["frame_path"], target["bounds"], api_key())
            named_prompt = named["prompt"]
            iso_id = isolation_id_for(clip_id, named_prompt)
            name_track(track, named["label"], named_prompt)
            save_track(directory, track)

            write_job(
                {
                    "id": clip_id,
                    "status": "running",
                    "stage": "isolating",
                    "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
                    "isolation_id": iso_id,
                    "cached": False,
                    "error": None,
                },
                root,
            )
            CACHE_VOLUME.commit()
            run_isolation(
                clip_id=clip_id,
                iso_id=iso_id,
                prompt=named_prompt,
                label=named["label"],
                model=self.model,
                processor=self.processor,
                cache_root=root,
            )
            name_track(track, named["label"], named_prompt, iso_id)
            save_track(directory, track)

            write_job(
                {
                    "id": clip_id,
                    "status": "done",
                    "stage": "done",
                    "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
                    "isolation_id": iso_id,
                    "cached": False,
                    "error": None,
                },
                root,
            )
        except Exception as err:
            LOGGER.exception("tap isolation failed for clip=%s: %s", clip_id, err)
            error_message = (
                str(err).strip()
                if isinstance(err, (ValueError, IngestError)) and str(err).strip()
                else "Could not isolate the selected sound. Please try again."
            )
            write_job(
                {
                    "id": clip_id,
                    "status": "error",
                    "stage": "error",
                    "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
                    "isolation_id": iso_id,
                    "cached": False,
                    "error": error_message,
                },
                root,
            )
        else:
            if iso_id is not None and named_prompt is not None:
                # Committed first, for the same reason as the text path: the follow-ups read this
                # isolation's output as they start.
                CACHE_VOLUME.commit()
                self._queue_follow_up(clip_id, iso_id, named_prompt)
        finally:
            CACHE_VOLUME.commit()


@app.function(
    image=analyze_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    timeout=ANALYZE_TIMEOUT_SECONDS,
    gpu=None,
)
def analyze_worker(clip_id: str) -> None:
    """Apply CPU clip analysis and finish the job without blocking playback."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        try:
            # This worker is only started for a fresh ingest, so suggestions begin before Pick.
            suggest_worker.spawn(clip_id)
        except Exception:
            # The clip remains usable with its default suggestions if Muse is unavailable.
            LOGGER.exception("could not queue suggestions for clip=%s", clip_id)
        apply_analysis(clip_id)
    except Exception:
        # Failure only degrades harmony view; the playable, isolatable clip never blocks.
        LOGGER.exception("analysis failed for clip=%s", clip_id)
    finally:
        write_job(
            {
                "id": clip_id,
                "status": "done",
                "stage": "done",
                "trackmap_url": f"/files/clips/{clip_id}/trackmap.json",
                "isolation_id": None,
                "cached": False,
                "error": None,
            }
        )
        CACHE_VOLUME.commit()


@app.function(
    image=basic_pitch_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    timeout=TRANSCRIBE_TIMEOUT_SECONDS,
    gpu=None,
)
def transcribe_worker(clip_id: str, isolation_id: str) -> None:
    """Apply CPU Basic Pitch transcription without blocking playable isolation output."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        # Basic Pitch handles a 30-second clip on CPU without reserving a GPU.
        apply_transcription(clip_id, isolation_id)
        CACHE_VOLUME.commit()
        try:
            summary_worker.spawn(clip_id, isolation_id)
        except Exception:
            # The notes remain usable when a text-only summary cannot be queued.
            LOGGER.exception(
                "could not queue summary for clip=%s isolation=%s", clip_id, isolation_id
            )
    except Exception:
        # Failure only removes an optional enhancement; the playable isolation must not break.
        LOGGER.exception("transcription failed for clip=%s isolation=%s", clip_id, isolation_id)
    finally:
        CACHE_VOLUME.commit()


@app.function(
    image=analyze_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    secrets=[BASETEN_SECRET],
    timeout=RECIPE_TIMEOUT_SECONDS,
    gpu=None,
)
def recipe_worker(clip_id: str, isolation_id: str) -> None:
    """Build the optional partner-hosted recipe. Muse Spark Open is an HTTP call, so no GPU."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        write_recipe(clip_id, isolation_id)
    except Exception:
        # The isolated WAV and its notes stay usable when partner inference is unavailable.
        LOGGER.exception("recipe failed for clip=%s isolation=%s", clip_id, isolation_id)
    finally:
        CACHE_VOLUME.commit()


@app.function(
    image=web_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    secrets=[API_SECRET],
    timeout=SUGGEST_TIMEOUT_SECONDS,
    gpu=None,
)
def suggest_worker(clip_id: str) -> None:
    """Generate optional Muse Spark chips without reserving a GPU or blocking the clip."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        suggest_clip(clip_id)
    except Exception:
        # Suggestion failure only leaves the ingest-time fallback chips in place.
        LOGGER.exception("suggest failed for clip=%s", clip_id)
    finally:
        CACHE_VOLUME.commit()


@app.function(
    image=web_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    secrets=[API_SECRET],
    timeout=SUMMARY_TIMEOUT_SECONDS,
    gpu=None,
)
def summary_worker(clip_id: str, isolation_id: str) -> None:
    """Write an optional, fact-checked Muse summary after transcription has produced its facts."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        write_isolation_summary(clip_id, isolation_id)
    except Exception:
        # An isolation without a summary remains fully playable and learnable.
        LOGGER.exception("summary failed for clip=%s isolation=%s", clip_id, isolation_id)
    finally:
        CACHE_VOLUME.commit()


@app.function(
    image=demucs_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    timeout=FALLBACK_TIMEOUT_SECONDS,
    gpu=None,
)
def fallback_worker(clip_id: str) -> None:
    """Create CPU Demucs alternatives without blocking playable isolation output."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        # Demucs handles a 30-second clip on CPU without reserving a GPU.
        run_fallback(clip_id)
    except Exception:
        # Failure only removes an optional enhancement; the playable isolation must not break.
        LOGGER.exception("fallback failed for clip=%s", clip_id)
    finally:
        CACHE_VOLUME.commit()


@app.function(
    image=web_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    schedule=modal.Period(days=1),
    timeout=CLEANUP_TIMEOUT_SECONDS,
    gpu=None,
)
def cleanup_old_uploads() -> int:
    """Daily job that removes uploaded clips and job files older than 7 days."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    removed = cleanup_expired_clips()
    if removed > 0:
        CACHE_VOLUME.commit()
    return removed


@app.function(
    image=web_image,
    volumes={DEFAULT_CACHE_PATH: CACHE_VOLUME},
    secrets=[API_SECRET],
    timeout=WEB_TIMEOUT_SECONDS,
    gpu=None,
)
@modal.asgi_app()
def api() -> FastAPI:
    """Serve the Mixray HTTP API."""
    from web import create_api

    return create_api(
        spawn_isolation=IsolationWorker().isolate.spawn,
        spawn_tap_isolation=IsolationWorker().track_and_isolate.spawn,
        spawn_analysis=analyze_worker.spawn,
        commit_volume=CACHE_VOLUME.commit,
        reload_volume=CACHE_VOLUME.reload,
    )
