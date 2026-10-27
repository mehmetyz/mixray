"""Modal application entrypoint for Mixray."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import modal

from images import sam_audio_image, web_image
from ingest import DEFAULT_CACHE_PATH, cleanup_expired_clips, write_job
from isolate import HF_SECRET, MEASURE_GPU, WEIGHTS_PATH, WEIGHTS_VOLUME, run_isolation

if TYPE_CHECKING:
    from fastapi import FastAPI

LOGGER = logging.getLogger(__name__)

WEB_TIMEOUT_SECONDS = 120
ISOLATE_TIMEOUT_SECONDS = 300
CLEANUP_TIMEOUT_SECONDS = 300
MAX_ISOLATE_CONTAINERS = 2

CACHE_VOLUME = modal.Volume.from_name("mixray-cache", create_if_missing=True)
API_SECRET = modal.Secret.from_name("mixray-secrets")

app = modal.App("mixray")


@app.function(
    image=sam_audio_image,
    gpu=MEASURE_GPU,
    volumes={WEIGHTS_PATH: WEIGHTS_VOLUME, DEFAULT_CACHE_PATH: CACHE_VOLUME},
    secrets=[HF_SECRET],
    timeout=ISOLATE_TIMEOUT_SECONDS,
    max_containers=MAX_ISOLATE_CONTAINERS,
)
def isolate_worker(clip_id: str, iso_id: str, prompt: str, label: str) -> None:
    """Run SAM Audio separation on GPU and commit outputs to mixray-cache."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    try:
        run_isolation(clip_id=clip_id, iso_id=iso_id, prompt=prompt, label=label)
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
        spawn_isolation=isolate_worker.spawn,
        commit_volume=CACHE_VOLUME.commit,
        reload_volume=CACHE_VOLUME.reload,
    )
