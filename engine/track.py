"""Turn a tap on a video frame into the masks that tell SAM Audio which sound to isolate.

SAM 3.1 segments pixels and produces no audio at all; SAM Audio separates audio and cannot be
pointed at anything on screen. This is the join between them: a point prompt goes to SAM 3.1, the
masks it returns come back here as polygons for the UI and as a raster for SAM Audio's visual
prompt.

The mask payload is base85 in a variant the docs do not name, so decoding uses Meta's own
`meta_sam_parser` rather than a guess.
"""

import asyncio
import json
import logging
import re
import subprocess
from collections.abc import AsyncIterator, Iterable, Iterator
from pathlib import Path
from typing import TYPE_CHECKING, Literal, TypedDict

import modal

# `meta_sam_parser` is pure Python with no dependencies, so it costs nothing to import up here and
# keeping the names at module scope lets the type checker see the record union properly.
from meta_sam_parser import (
    FramePrompt,
    PromptObject,
    PromptPoint,
    SegmentationMask,
    SegmentationMaskBounds,
    SegmentationMaskRecord,
    VideoSegmentationResult,
    build_object_prompt,
    decode_mask_to_raster,
    decode_mask_to_svg_path,
    parse_responses_stream,
    video_segmentation_format,
)

import meta_api
from images import web_image
from ingest import VIDEO_FPS, clip_dir, get_cache_root

if TYPE_CHECKING:
    import torch

LOGGER = logging.getLogger(__name__)

app = modal.App("mixray-track")

CACHE_VOLUME = modal.Volume.from_name("mixray-cache", create_if_missing=True)
CACHE_PATH = "/cache"
API_SECRET = modal.Secret.from_name("mixray-secrets")

TRACK_TIMEOUT_SECONDS = 600
SAM_MODEL = "sam-3.1"
VIDEO_MEDIA_TYPE = "video/mp4"
TRACK_OBJECT_ID = 1
# The wire format carries object ids as text, so records are matched against the string form.
TRACK_OBJECT_KEY = str(TRACK_OBJECT_ID)
# Masks propagate from the tapped frame onwards, which is what a user expects after tapping once.
PROPAGATION = "forward"
# A gap longer than this between answered frames ends a visible range rather than being bridged.
VISIBLE_GAP_SECONDS = 0.5


class FramePolygons(TypedDict):
    """The outlines of one tracked object on one frame, as SVG path data."""

    frame: int
    time: float
    paths: list[str]


class StoredMask(TypedDict):
    """The complete, box-local SAM 3.1 mask needed to reconstruct a raster."""

    encoding: Literal["one_bit", "lossless"]
    payload: str
    width: int
    height: int


class StoredMaskBounds(TypedDict):
    """The half-open source-frame rectangle covered by one stored mask."""

    left: float
    top: float
    right: float
    bottom: float


class StoredMaskRecord(TypedDict):
    """One frame's source mask, retained separately from its UI outline."""

    frame: int
    mask: StoredMask
    bounds: StoredMaskBounds


class TrackResult(TypedDict):
    """What one tap produces: an outline per answered frame, and when the object is on screen."""

    id: str
    label: str
    prompt: str
    frames: list[FramePolygons]
    visible: list[list[float]]
    masks: list[StoredMaskRecord]


def point_prompt(width: int, height: int, x: int, y: int, frame: int) -> str:
    """Write the prompt string for a single positive point on one frame.

    Built with Meta's helper rather than by hand: the wire format packs the frame index, the object
    id and the media size into one token, and getting that wrong is silent.
    """
    return build_object_prompt(
        size=(width, height),
        objects=[
            PromptObject(
                id=TRACK_OBJECT_ID,
                prompts=[FramePrompt(frame=frame, points=[PromptPoint(x, y)])],
            )
        ],
    )


def segmentation_video(source: Path, destination: Path, fps: int = VIDEO_FPS) -> None:
    """Re-encode the clip at the mask frame rate before segmenting it.

    Frame indices in the reply are indices into whatever video was sent, and `build_track` turns
    them into seconds by dividing by this same rate, so sending the source copy at its own frame
    rate would stretch every visible range by the ratio between them. Billing is per frame as well,
    so this is both the correct and the cheaper thing to send.
    """
    argv = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-vf",
        f"fps={fps}",
        "-an",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-pix_fmt",
        "yuv420p",
        str(destination),
    ]
    subprocess.run(argv, check=True, capture_output=True)


def segmentation_payload(video_path: Path, prompt: str) -> dict[str, object]:
    return {
        "model": SAM_MODEL,
        "input": [
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_video",
                        "video_url": meta_api.data_url(video_path, VIDEO_MEDIA_TYPE),
                    },
                ],
            }
        ],
        "metadata": {"propagation_direction": PROPAGATION},
    }


async def _collect(events: Iterable[dict[str, object]]) -> VideoSegmentationResult:
    async def source() -> AsyncIterator[dict[str, object]]:
        for event in events:
            yield event

    stream = parse_responses_stream(source(), video_segmentation_format())
    try:
        return await stream.final_result()
    finally:
        await stream.aclose()


def parse_segmentation(events: Iterable[dict[str, object]]) -> VideoSegmentationResult:
    """Run the parser over already-collected events.

    The parser is async and single-consumer; the events are small and few enough to gather first,
    which keeps the Modal function synchronous like every other worker here.
    """
    return asyncio.run(_collect(events))


def _mask_records(result: VideoSegmentationResult) -> Iterator[SegmentationMaskRecord]:
    for record in result.records:
        if isinstance(record, SegmentationMaskRecord) and record.object_id == TRACK_OBJECT_KEY:
            yield record


def visible_ranges(times: list[float], gap: float = VISIBLE_GAP_SECONDS) -> list[list[float]]:
    """Group the times the object was found into [start, end] spans."""
    if not times:
        return []
    ordered = sorted(times)
    spans: list[list[float]] = [[ordered[0], ordered[0]]]
    for time in ordered[1:]:
        if time - spans[-1][1] > gap:
            spans.append([time, time])
        else:
            spans[-1][1] = time
    return [[round(start, 3), round(end, 3)] for start, end in spans]


PATH_COMMAND = re.compile(r"([ML])(-?[\d.]+)\s+(-?[\d.]+)")


def to_frame_space(path: str, mask: SegmentationMask, bounds: SegmentationMaskBounds) -> str:
    """Rewrite a mask-local SVG path in source-frame pixels.

    The raster is box-local: its width and height are its own, not the frame's, and `bounds` says
    which part of the frame it covers. Without this the UI would draw every outline bunched into
    the top-left corner, at the size of the raster rather than of the object.
    """
    scale_x = (bounds.right - bounds.left) / mask.width if mask.width else 0.0
    scale_y = (bounds.bottom - bounds.top) / mask.height if mask.height else 0.0

    def move(match: re.Match[str]) -> str:
        command, raw_x, raw_y = match.group(1), float(match.group(2)), float(match.group(3))
        x = bounds.left + raw_x * scale_x
        y = bounds.top + raw_y * scale_y
        return f"{command}{x:.1f} {y:.1f}"

    rewritten, count = PATH_COMMAND.subn(move, path)
    if count == 0:
        raise RuntimeError("mask path had no move or line commands to place")
    return rewritten


def _stored_mask_record(record: SegmentationMaskRecord, frame: int) -> StoredMaskRecord:
    """Keep the parser-owned payload so visual isolation never has to rasterize an SVG outline."""
    return {
        "frame": frame,
        "mask": {
            "encoding": record.mask.encoding,
            "payload": record.mask.payload,
            "width": record.mask.width,
            "height": record.mask.height,
        },
        "bounds": {
            "left": record.bounds.left,
            "top": record.bounds.top,
            "right": record.bounds.right,
            "bottom": record.bounds.bottom,
        },
    }


def _place_mask(
    output: "torch.Tensor", record: StoredMaskRecord, frame_count: int, width: int, height: int
) -> None:
    """Set the tracked object to zero in SAM Audio's inverted full-frame mask."""
    import torch
    from torch.nn import functional as functions

    frame = record["frame"]
    if frame < 0 or frame >= frame_count:
        raise ValueError(f"mask frame {frame} is outside the clip's {frame_count} frames")

    source = record["mask"]
    bounds = record["bounds"]
    raster = decode_mask_to_raster(
        SegmentationMask(
            encoding=source["encoding"],
            payload=source["payload"],
            width=source["width"],
            height=source["height"],
        )
    )
    expected_size = source["width"] * source["height"]
    if len(raster) != expected_size:
        raise RuntimeError("decoded mask size did not match its dimensions")

    left = round(bounds["left"])
    top = round(bounds["top"])
    right = round(bounds["right"])
    bottom = round(bounds["bottom"])
    placed_width = right - left
    placed_height = bottom - top
    if placed_width <= 0 or placed_height <= 0:
        raise ValueError("mask bounds must cover at least one pixel")

    local = torch.frombuffer(bytearray(raster), dtype=torch.uint8).reshape(
        source["height"], source["width"]
    )
    placed = functions.interpolate(
        local.unsqueeze(0).unsqueeze(0).to(torch.float32),
        size=(placed_height, placed_width),
        mode="nearest",
    ).to(torch.uint8)[0, 0]

    destination_left = max(0, left)
    destination_top = max(0, top)
    destination_right = min(width, right)
    destination_bottom = min(height, bottom)
    if destination_left >= destination_right or destination_top >= destination_bottom:
        return

    source_left = destination_left - left
    source_top = destination_top - top
    source_right = source_left + destination_right - destination_left
    source_bottom = source_top + destination_bottom - destination_top
    object_pixels = placed[source_top:source_bottom, source_left:source_right].bool()
    destination = output[
        frame, :, destination_top:destination_bottom, destination_left:destination_right
    ]
    destination.masked_fill_(object_pixels.unsqueeze(0), 0)


def track_mask_tensor(
    track: TrackResult, frame_count: int, width: int, height: int
) -> "torch.Tensor":
    """Build the uint8 NCHW mask `SAMAudioProcessor.mask_videos` expects for one track.

    SAM Audio keeps pixels whose corresponding mask value is zero. The SAM 3.1 raster has ones on
    the object, so the full-frame tensor starts as ones and `_place_mask` clears the object pixels.
    """
    import torch

    if frame_count <= 0:
        raise ValueError("frame_count must be positive")
    if width <= 0 or height <= 0:
        raise ValueError("video dimensions must be positive")
    if not track["masks"]:
        raise ValueError("track has no SAM 3.1 mask records")

    output = torch.ones((frame_count, 3, height, width), dtype=torch.uint8)
    for record in track["masks"]:
        _place_mask(output, record, frame_count, width, height)
    return output


def build_track(
    result: VideoSegmentationResult, track_id: str, label: str, prompt: str, fps: int = VIDEO_FPS
) -> TrackResult:
    """Turn the parsed records into polygons per frame plus the spans the object is on screen."""
    by_frame: dict[int, list[str]] = {}
    masks: list[StoredMaskRecord] = []
    for record in _mask_records(result):
        # `frame` is a FrameReference, and an image result carries none at all.
        if record.frame is None:
            continue
        index = record.frame.frame_index
        placed = to_frame_space(decode_mask_to_svg_path(record.mask), record.mask, record.bounds)
        by_frame.setdefault(index, []).append(placed)
        masks.append(_stored_mask_record(record, index))

    frames: list[FramePolygons] = []
    for frame in sorted(by_frame):
        frames.append({"frame": frame, "time": round(frame / fps, 3), "paths": by_frame[frame]})
    return {
        "id": track_id,
        "label": label,
        "prompt": prompt,
        "frames": frames,
        "visible": visible_ranges([item["time"] for item in frames]),
        "masks": masks,
    }


class TapRequest(TypedDict):
    """Where the user tapped: pixel coordinates on one frame, and what to call the result."""

    x: int
    y: int
    frame: int
    label: str


def track_point(clip_id: str, tap: TapRequest, cache_root: Path | None = None) -> TrackResult:
    """Segment whatever was tapped, and write the result to the clip's own sidecar."""
    root = cache_root if cache_root is not None else get_cache_root()
    directory = clip_dir(clip_id, root)
    video_path = directory / "video.mp4"
    if not video_path.exists():
        raise FileNotFoundError(f"clip {clip_id} has no video: {video_path}")

    meta = json.loads((directory / "trackmap.json").read_text(encoding="utf-8"))
    video_meta = meta.get("video")
    if not isinstance(video_meta, dict):
        raise RuntimeError(f"clip {clip_id} is not a video clip")
    width, height = int(video_meta["width"]), int(video_meta["height"])

    x, y, frame = tap["x"], tap["y"], tap["frame"]
    prompt = point_prompt(width, height, x, y, frame)
    segment_path = directory / "segment_input.mp4"
    segmentation_video(video_path, segment_path)
    LOGGER.info("segmenting clip=%s at (%d,%d) on frame %d", clip_id, x, y, frame)
    events = list(
        meta_api.stream_responses(segmentation_payload(segment_path, prompt), meta_api.api_key())
    )
    result = parse_segmentation(events)

    track_id = f"tap{x}x{y}f{frame}"
    track = build_track(result, track_id, tap["label"], f"tap@{x},{y}")
    tracks_dir = directory / "tracks"
    tracks_dir.mkdir(parents=True, exist_ok=True)
    (tracks_dir / f"{track_id}.json").write_text(json.dumps(track), encoding="utf-8")
    LOGGER.info(
        "tracked %s: %d frames, %d visible span(s)",
        track_id,
        len(track["frames"]),
        len(track["visible"]),
    )
    return track


@app.function(
    image=web_image,
    volumes={CACHE_PATH: CACHE_VOLUME},
    secrets=[API_SECRET],
    timeout=TRACK_TIMEOUT_SECONDS,
    gpu=None,
)
def track_worker(
    clip_id: str, x: int, y: int, frame: int = 0, label: str = "Tapped sound"
) -> TrackResult:
    """SAM 3.1 is hosted, so this is an HTTP call and needs no GPU."""
    logging.basicConfig(level=logging.INFO)
    CACHE_VOLUME.reload()
    tap: TapRequest = {"x": x, "y": y, "frame": frame, "label": label}
    try:
        return track_point(clip_id, tap)
    finally:
        CACHE_VOLUME.commit()
