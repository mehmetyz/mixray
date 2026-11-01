"""Name an area drawn on a video frame, and follow it through the clip when the UI asks.

SAM 3.1 segments pixels and produces no audio at all; SAM Audio separates audio and cannot be
pointed at anything on screen. The join between them is a name: Muse Spark names the drawn area, and
that name drives the separation. SAM 3.1 only runs for the on-demand overlay.

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
from typing import NotRequired, TypedDict

# `meta_sam_parser` is pure Python with no dependencies, so it costs nothing to import up here and
# keeping the names at module scope lets the type checker see the record union properly.
from meta_sam_parser import (
    FramePrompt,
    PromptBox,
    PromptObject,
    SegmentationMask,
    SegmentationMaskBounds,
    SegmentationMaskRecord,
    VideoSegmentationResult,
    build_object_prompt,
    decode_mask_to_svg_path,
    parse_responses_stream,
    video_segmentation_format,
)

import meta_api
from ingest import VIDEO_FPS, clip_dir, get_cache_root
from label import RegionBounds, label_region

LOGGER = logging.getLogger(__name__)

SAM_MODEL = "sam-3.1"
VIDEO_MEDIA_TYPE = "video/mp4"
TRACK_OBJECT_ID = 1
# The wire format carries object ids as text, so records are matched against the string form.
TRACK_OBJECT_KEY = str(TRACK_OBJECT_ID)
# Masks propagate from the selected frame onwards.
PROPAGATION = "forward"
# A gap longer than this between answered frames ends a visible range rather than being bridged.
VISIBLE_GAP_SECONDS = 0.5
# Measured on a 30 s clip: 640 px at 5 fps tracks in 45 s where 1280 px at 10 fps took over 400 s,
# nearly all of it decoding masks into polygons, with the object's bounds unchanged.
MASK_FPS = 5
MASK_WIDTH = 640


class FramePolygons(TypedDict):
    """The outlines of one tracked object on one frame, as SVG path data."""

    frame: int
    time: float
    paths: list[str]


class TrackSelection(TypedDict):
    """The area drawn in stored-video pixels, and the 10 fps frame it was drawn on."""

    bounds: RegionBounds
    frame: int


class TrackResult(TypedDict):
    """One named area: an outline per answered frame once followed, and when it is on screen."""

    id: str
    label: str
    prompt: str
    frames: list[FramePolygons]
    visible: list[list[float]]
    selection: TrackSelection
    isolation_id: NotRequired[str]
    follow_error: NotRequired[str]


def box_prompt(size: tuple[int, int], bounds: RegionBounds, frame: int) -> str:
    """Write the prompt string for one box on one frame.

    Built with Meta's helper rather than by hand: the wire format packs the frame index, the object
    id and the media size into one token, and getting that wrong is silent.
    """
    box = PromptBox(bounds["left"], bounds["top"], bounds["right"], bounds["bottom"])
    return build_object_prompt(
        size=size,
        objects=[PromptObject(id=TRACK_OBJECT_ID, prompts=[FramePrompt(frame=frame, box=box)])],
    )


def segmentation_video(source: Path, destination: Path, size: tuple[int, int]) -> None:
    """Re-encode the clip at the mask size and frame rate before segmenting it.

    Frame indices and mask pixels in the reply refer to whatever video was sent, so `build_track`
    converts them back using these same values. Billing is per frame as well.
    """
    argv = [
        "ffmpeg",
        "-y",
        "-i",
        str(source),
        "-vf",
        f"fps={MASK_FPS},scale={size[0]}:{size[1]}",
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


def to_frame_space(
    path: str,
    mask: SegmentationMask,
    bounds: SegmentationMaskBounds,
    video_scale: tuple[float, float],
) -> str:
    """Rewrite a mask-local SVG path in source-frame pixels.

    The raster is box-local: its width and height are its own, not the frame's, and `bounds` says
    which part of the frame it covers. Without this the UI would draw every outline bunched into
    the top-left corner, at the size of the raster rather than of the object. `video_scale` then
    undoes the downscale of the video that was sent.
    """
    scale_x = (bounds.right - bounds.left) / mask.width if mask.width else 0.0
    scale_y = (bounds.bottom - bounds.top) / mask.height if mask.height else 0.0

    def move(match: re.Match[str]) -> str:
        command, raw_x, raw_y = match.group(1), float(match.group(2)), float(match.group(3))
        x = (bounds.left + raw_x * scale_x) * video_scale[0]
        y = (bounds.top + raw_y * scale_y) * video_scale[1]
        return f"{command}{x:.1f} {y:.1f}"

    rewritten, count = PATH_COMMAND.subn(move, path)
    if count == 0:
        raise RuntimeError("mask path had no move or line commands to place")
    return rewritten


def build_track(
    result: VideoSegmentationResult, track: TrackResult, video_scale: tuple[float, float]
) -> TrackResult:
    """Add the polygons per frame and the spans the object is on screen to a named track."""
    by_frame: dict[int, list[str]] = {}
    for record in _mask_records(result):
        # `frame` is a FrameReference, and an image result carries none at all.
        if record.frame is None:
            continue
        index = record.frame.frame_index * (VIDEO_FPS // MASK_FPS)
        placed = to_frame_space(
            decode_mask_to_svg_path(record.mask), record.mask, record.bounds, video_scale
        )
        by_frame.setdefault(index, []).append(placed)

    frames: list[FramePolygons] = []
    for frame in sorted(by_frame):
        frames.append(
            {"frame": frame, "time": round(frame / VIDEO_FPS, 3), "paths": by_frame[frame]}
        )
    followed = track.copy()
    followed["frames"] = frames
    followed["visible"] = visible_ranges([item["time"] for item in frames])
    return followed


def _video_dimensions(directory: Path) -> tuple[int, int]:
    """Read the dimensions of the stored 720p video copy."""
    metadata = json.loads((directory / "trackmap.json").read_text(encoding="utf-8"))
    if not isinstance(metadata, dict):
        raise RuntimeError("clip trackmap is not an object")
    video = metadata.get("video")
    if not isinstance(video, dict):
        raise RuntimeError("area selection requires a video clip")
    width, height = video.get("width"), video.get("height")
    if isinstance(width, bool) or not isinstance(width, int) or width <= 0:
        raise RuntimeError("clip video width is invalid")
    if isinstance(height, bool) or not isinstance(height, int) or height <= 0:
        raise RuntimeError("clip video height is invalid")
    return width, height


def _track_path(directory: Path, track_id: str) -> Path:
    return directory / "tracks" / f"{track_id}.json"


def save_track(directory: Path, track: TrackResult) -> None:
    """Atomically persist one tracking sidecar without mutating the base TrackMap."""
    path = _track_path(directory, track["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(track), encoding="utf-8")
    temporary.replace(path)


def name_selection(
    clip_id: str, bounds: RegionBounds, frame: int, cache_root: Path | None = None
) -> TrackResult:
    """Name what the user drew a box around, and write it to the clip's own sidecar."""
    root = cache_root if cache_root is not None else get_cache_root()
    directory = clip_dir(clip_id, root)
    frame_path = directory / "frames" / f"frame_{frame + 1:04d}.jpg"
    if not frame_path.is_file():
        raise ValueError("Frame is outside the video clip.")

    named = label_region(frame_path, bounds, meta_api.api_key())
    left, top, right, bottom = bounds["left"], bounds["top"], bounds["right"], bounds["bottom"]
    track: TrackResult = {
        "id": f"area{left}x{top}x{right}x{bottom}f{frame}",
        "label": named["label"],
        "prompt": named["prompt"],
        "frames": [],
        "visible": [],
        "selection": {"bounds": bounds, "frame": frame},
    }
    save_track(directory, track)
    return track


def _bounds_from_json(raw: object) -> RegionBounds:
    if not isinstance(raw, dict):
        raise ValueError("track selection has no bounds")
    left, top, right, bottom = raw.get("left"), raw.get("top"), raw.get("right"), raw.get("bottom")
    if (
        not isinstance(left, int)
        or not isinstance(top, int)
        or not isinstance(right, int)
        or not isinstance(bottom, int)
    ):
        raise ValueError("track selection bounds are invalid")
    return {"left": left, "top": top, "right": right, "bottom": bottom}


def read_track(directory: Path, track_id: str) -> TrackResult:
    """Read the named part of a sidecar; its frames are what following writes."""
    raw = json.loads(_track_path(directory, track_id).read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("track sidecar is not an object")
    label, prompt, selection = raw.get("label"), raw.get("prompt"), raw.get("selection")
    if not isinstance(label, str) or not isinstance(prompt, str) or not isinstance(selection, dict):
        raise ValueError("track sidecar has no selection")
    frame = selection.get("frame")
    if not isinstance(frame, int):
        raise ValueError("track selection has no frame")
    track: TrackResult = {
        "id": track_id,
        "label": label,
        "prompt": prompt,
        "frames": [],
        "visible": [],
        "selection": {"bounds": _bounds_from_json(selection.get("bounds")), "frame": frame},
    }
    isolation_id = raw.get("isolation_id")
    if isinstance(isolation_id, str):
        track["isolation_id"] = isolation_id
    return track


def follow_track(clip_id: str, track_id: str, cache_root: Path | None = None) -> TrackResult:
    """Track a named area through the rest of the clip with SAM 3.1, at the reduced mask size."""
    root = cache_root if cache_root is not None else get_cache_root()
    directory = clip_dir(clip_id, root)
    track = read_track(directory, track_id)
    width, height = _video_dimensions(directory)
    mask_width = min(width, MASK_WIDTH)
    # libx264 only accepts even dimensions.
    mask_height = round(height * mask_width / width / 2) * 2
    scale_x, scale_y = width / mask_width, height / mask_height
    bounds = track["selection"]["bounds"]
    scaled: RegionBounds = {
        "left": int(bounds["left"] / scale_x),
        "top": int(bounds["top"] / scale_y),
        "right": min(mask_width, round(bounds["right"] / scale_x)),
        "bottom": min(mask_height, round(bounds["bottom"] / scale_y)),
    }
    frame = track["selection"]["frame"] * MASK_FPS // VIDEO_FPS
    segment_path = directory / "segment_input.mp4"
    segmentation_video(directory / "video.mp4", segment_path, (mask_width, mask_height))
    prompt = box_prompt((mask_width, mask_height), scaled, frame)
    events = list(
        meta_api.stream_responses(segmentation_payload(segment_path, prompt), meta_api.api_key())
    )
    followed = build_track(parse_segmentation(events), track, (scale_x, scale_y))
    if not followed["frames"]:
        raise RuntimeError("SAM 3.1 returned no masks for this area.")
    save_track(directory, followed)
    LOGGER.info("followed %s: %d frames", track_id, len(followed["frames"]))
    return followed


def record_follow_error(clip_id: str, track_id: str, message: str) -> None:
    """Tell the polling UI that following failed, instead of leaving it to time out."""
    directory = clip_dir(clip_id, get_cache_root())
    track = read_track(directory, track_id)
    track["follow_error"] = message
    save_track(directory, track)
