"""One client for the Meta Model API, shared by every feature that calls it.

`suggest` and `track` already need the same base URL, the same bearer header and the same retry
rule, and `coach` and `recipe` will too, so the transport lives here once rather than in each.
"""

import json
import logging
import os
from collections.abc import Iterator
from pathlib import Path

LOGGER = logging.getLogger(__name__)

BASE_URL = "https://api.meta.ai/v1"
RESPONSES_PATH = "/responses"
API_KEY_ENV = "META_API_KEY"

REQUEST_TIMEOUT_SECONDS = 300.0
ATTEMPTS = 3
HTTP_OK = 200
HTTP_SERVER_ERROR = 500

SSE_DATA_PREFIX = "data:"
SSE_DONE = "[DONE]"


def api_key() -> str:
    key = os.environ.get(API_KEY_ENV, "").strip()
    if not key:
        raise RuntimeError(f"{API_KEY_ENV} is not set")
    return key


def _headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}"}


def data_url(path: Path, media_type: str) -> str:
    """Inline a file as a base64 data URL.

    Media parts take `video_url` or `file_id` and reject a raw `data` field, so bytes sent inline
    have to be spelled this way.
    """
    import base64

    encoded = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{media_type};base64,{encoded}"


def post_responses(payload: dict[str, object], key: str) -> dict[str, object]:
    """Send one Responses call, retrying on transport errors and 5xx."""
    import httpx

    last_error = ""
    for attempt in range(1, ATTEMPTS + 1):
        try:
            response = httpx.post(
                f"{BASE_URL}{RESPONSES_PATH}",
                headers=_headers(key),
                json=payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
            )
        except httpx.HTTPError as error:
            last_error = f"{type(error).__name__}: {error}"
            LOGGER.warning("attempt %d/%d failed: %s", attempt, ATTEMPTS, last_error)
            continue
        if response.status_code >= HTTP_SERVER_ERROR:
            last_error = f"HTTP {response.status_code}"
            LOGGER.warning("attempt %d/%d got %s", attempt, ATTEMPTS, last_error)
            continue
        if response.status_code != HTTP_OK:
            raise RuntimeError(f"Meta API returned HTTP {response.status_code}: {response.text}")
        parsed: dict[str, object] = response.json()
        return parsed
    raise RuntimeError(f"Meta API unreachable after {ATTEMPTS} attempts: {last_error}")


def stream_responses(payload: dict[str, object], key: str) -> Iterator[dict[str, object]]:
    """Send one streaming Responses call and yield each server-sent event as a dict.

    Segmentation answers one line per frame, so a long clip arrives as many deltas; streaming is
    the documented way to read it.
    """
    import httpx

    streamed = dict(payload)
    streamed["stream"] = True
    with httpx.stream(
        "POST",
        f"{BASE_URL}{RESPONSES_PATH}",
        headers=_headers(key),
        json=streamed,
        timeout=REQUEST_TIMEOUT_SECONDS,
    ) as response:
        if response.status_code != HTTP_OK:
            response.read()
            raise RuntimeError(f"Meta API returned HTTP {response.status_code}: {response.text}")
        for line in response.iter_lines():
            if not line.startswith(SSE_DATA_PREFIX):
                continue
            body = line[len(SSE_DATA_PREFIX) :].strip()
            if not body or body == SSE_DONE:
                continue
            event: dict[str, object] = json.loads(body)
            yield event


def output_text(reply: dict[str, object]) -> str:
    """Pull the assistant's text out of a Responses reply.

    Content parts nest inside output items and reasoning items carry no text, so every text part is
    collected rather than assuming the first item holds the answer.
    """
    output = reply.get("output")
    if not isinstance(output, list):
        raise RuntimeError("Meta API reply had no output")
    chunks: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for part in content:
            if isinstance(part, dict) and isinstance(part.get("text"), str):
                chunks.append(part["text"])
    text = "\n".join(chunks).strip()
    if not text:
        raise RuntimeError("Meta API reply carried no text")
    return text
