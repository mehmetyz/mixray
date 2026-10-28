"""Modal application entrypoint for Mixray."""

from __future__ import annotations

import logging
import os
from typing import TYPE_CHECKING

import modal

from analyze import apply_analysis
from fallback import run_fallback, stem_for_prompt
from images import analyze_image, basic_pitch_image, demucs_image, sam_audio_image, web_image
from ingest import DEFAULT_CACHE_PATH, cleanup_expired_clips, write_job
from isolate import (
    DEFAULT_MODEL_ID,
    HF_SECRET,
    MEASURE_GPU,
    RANKERS_OFF,
    WEIGHTS_PATH,
    WEIGHTS_VOLUME,
    run_isolation,
)
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
CLEANUP_TIMEOUT_SECONDS = 300
MAX_ISOLATE_CONTAINERS = 2

CACHE_VOLUME = modal.Volume.from_name("mixray-cache", create_if_missing=True)
API_SECRET = modal.Secret.from_name("mixray-secrets")

app = modal.App("mixray")


@app.cls(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME, DEFAULT_CACHE_PATH: CACHE_VOLUME},
    secrets=[HF_SECRET],
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
            # Spawned outside the try above: the sound is already written and the job already says
            # done, so a follow-up that cannot even be queued must not relabel a successful
            # isolation as failed and tell the user to try another prompt.
            try:
                transcribe_worker.spawn(clip_id, iso_id)
                # Deliberately narrows T1.3's per-clip fallback to prompts that map to a standard
                # stem: Demucs has no equivalent for "supersaw lead", so running it would spend CPU
                # on an alternative the UI could never offer.
                if stem_for_prompt(prompt) is not None:
                    fallback_worker.spawn(clip_id)
            except Exception:
                LOGGER.exception("could not queue follow-up work for clip=%s", clip_id)
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
    except Exception:
        # Failure only removes an optional enhancement; the playable isolation must not break.
        LOGGER.exception("transcription failed for clip=%s isolation=%s", clip_id, isolation_id)
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
        spawn_analysis=analyze_worker.spawn,
        commit_volume=CACHE_VOLUME.commit,
        reload_volume=CACHE_VOLUME.reload,
    )
