"""Modal application entrypoint for Mixray."""

from __future__ import annotations

from typing import TYPE_CHECKING

import modal

from images import web_image

if TYPE_CHECKING:
    from fastapi import FastAPI


WEB_TIMEOUT_SECONDS = 60


app = modal.App("mixray")


@app.function(image=web_image, timeout=WEB_TIMEOUT_SECONDS, gpu=None)
@modal.asgi_app()
def api() -> FastAPI:
    """Serve the Mixray HTTP API."""

    from web import create_api  # noqa: PLC0415

    return create_api()
