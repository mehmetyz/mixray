"""FastAPI application factory for the Mixray engine."""

from fastapi import FastAPI
from pydantic import BaseModel


class HealthResponse(BaseModel):
    """Response returned by the health endpoint."""

    ok: bool


def get_health() -> HealthResponse:
    """Return the engine health status."""

    return HealthResponse(ok=True)


def create_api() -> FastAPI:
    """Create the engine HTTP API."""

    api = FastAPI()
    api.add_api_route("/health", get_health, methods=["GET"], response_model=HealthResponse)
    return api
