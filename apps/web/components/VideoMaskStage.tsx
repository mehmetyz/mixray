"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import {
  areaAroundPaths,
  areaOnStage,
  MIN_DRAG_PIXELS,
  videoAreaFromDrag,
  type PixelSize,
  type StagePoint,
  type VideoArea,
} from "@/lib/studio/area";
import type { TimeRange, Video } from "@/lib/trackmap/trackmap.generated";
import { useStudio } from "./StudioContext";

export type VideoMaskStageProps = {
  video: Video;
  /** Present where a sound is chosen: dragging over the video draws an area. */
  onSelectArea?: (area: VideoArea, frame: number) => void;
  areaBusy?: boolean;
  /** The one track whose box is drawn; following is opt-in on the Analyze screen. */
  followedTrackId?: string;
  /** Limits the video's width so the lanes under it stay on screen. */
  sizeClass: string;
};

// The stage below is `aspect-video`.
const STAGE_SIZE: PixelSize = { width: 16, height: 9 };

type AreaDrag = {
  start: StagePoint;
  end: StagePoint;
};

type MaskFrame = {
  frame: number;
  paths: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaskFrames(json: unknown): MaskFrame[] {
  if (!isRecord(json) || !Array.isArray(json.frames)) return [];
  const frames: MaskFrame[] = [];
  for (const raw of json.frames) {
    if (!isRecord(raw) || typeof raw.frame !== "number" || !Array.isArray(raw.paths)) continue;
    frames.push({
      frame: raw.frame,
      paths: raw.paths.filter((path): path is string => typeof path === "string"),
    });
  }
  return frames;
}

function isTimeInRanges(time: number, ranges: TimeRange[]): boolean {
  return ranges.some(([start, end]) => time >= start && time <= end);
}

function nearestFramePaths(frames: MaskFrame[], target: number): string[] {
  let nearest: MaskFrame | null = null;
  for (const frame of frames) {
    if (nearest === null || Math.abs(frame.frame - target) < Math.abs(nearest.frame - target)) {
      nearest = frame;
    }
  }
  return nearest?.paths ?? [];
}

export function VideoMaskStage({
  video,
  onSelectArea,
  areaBusy = false,
  followedTrackId,
  sizeClass,
}: VideoMaskStageProps) {
  const { currentTime, duration, playing, ratePercent, togglePlay } = useStudio();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [maskFrames, setMaskFrames] = useState<{ id: string; frames: MaskFrame[] } | null>(null);
  const [areaDrag, setAreaDrag] = useState<AreaDrag | null>(null);
  const [dragActive, setDragActive] = useState<boolean>(false);

  const fps = video.fps > 0 ? video.fps : 10;
  const followed = video.tracks.find((track) => track.id === followedTrackId);
  const masksUrl = followed !== undefined && followed.visible.length > 0 ? followed.masks_url : null;

  useEffect(() => {
    const element = videoRef.current;
    if (element !== null && Math.abs(element.currentTime - currentTime) > 0.25) {
      element.currentTime = currentTime;
    }
  }, [currentTime]);

  // At the audio's rate, or the sync above would keep dragging the picture back.
  useEffect(() => {
    if (videoRef.current !== null) videoRef.current.playbackRate = ratePercent / 100;
  }, [ratePercent]);

  useEffect(() => {
    const element = videoRef.current;
    if (element === null) return;
    if (playing) void element.play().catch(() => {});
    else element.pause();
  }, [playing]);

  useEffect(() => {
    if (masksUrl === null || followedTrackId === undefined) return;
    let cancelled = false;
    void fetch(masksUrl)
      .then((response) => (response.ok ? response.json() : null))
      .then((json: unknown) => {
        if (!cancelled) setMaskFrames({ id: followedTrackId, frames: parseMaskFrames(json) });
      })
      .catch(() => {
        if (!cancelled) setMaskFrames(null);
      });
    return () => {
      cancelled = true;
    };
  }, [masksUrl, followedTrackId]);

  const pointFromEvent = (event: PointerEvent<HTMLDivElement>): StagePoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const finishAreaDrag = (event: PointerEvent<HTMLDivElement>) => {
    setDragActive(false);
    if (areaDrag === null || onSelectArea === undefined) return;
    const end = pointFromEvent(event);
    const box = event.currentTarget.getBoundingClientRect();
    if (Math.hypot(end.x - areaDrag.start.x, end.y - areaDrag.start.y) < MIN_DRAG_PIXELS) {
      setAreaDrag(null);
      togglePlay();
      return;
    }
    setAreaDrag({ start: areaDrag.start, end });
    if (playing) togglePlay();
    const lastFrame = Math.max(0, Math.floor(duration * fps) - 1);
    onSelectArea(
      videoAreaFromDrag(
        areaDrag.start,
        end,
        { width: box.width, height: box.height },
        { width: video.width, height: video.height },
      ),
      Math.min(lastFrame, Math.round(currentTime * fps)),
    );
  };

  const showMask =
    followed !== undefined &&
    maskFrames?.id === followed.id &&
    isTimeInRanges(currentTime, followed.visible);
  const trackedArea = showMask
    ? areaAroundPaths(nearestFramePaths(maskFrames.frames, Math.round(currentTime * fps)))
    : null;
  const trackedBox =
    trackedArea === null
      ? null
      : areaOnStage(trackedArea, { width: video.width, height: video.height }, STAGE_SIZE);
  const hint =
    onSelectArea !== undefined
      ? areaBusy
        ? "Finding that sound"
        : "Drag over a sound"
      : followed !== undefined && trackedBox === null
        ? `Tracking ${followed.label}`
        : null;
  const onScreenPercent = (time: number) => (duration > 0 ? (time / duration) * 100 : 0);

  return (
    <div className="border-b border-line bg-bg p-3 md:p-4">
      <div className={`mx-auto ${sizeClass}`}>
        <div
          className={`relative aspect-video w-full touch-none overflow-hidden rounded-well border border-line bg-inset select-none ${
            onSelectArea !== undefined ? "cursor-crosshair" : "cursor-pointer"
          }`}
          onClick={onSelectArea === undefined ? togglePlay : undefined}
          onPointerDown={(event) => {
            if (onSelectArea === undefined || areaBusy) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            const point = pointFromEvent(event);
            setAreaDrag({ start: point, end: point });
            setDragActive(true);
          }}
          onPointerMove={(event) => {
            if (areaDrag !== null && dragActive) {
              setAreaDrag({ start: areaDrag.start, end: pointFromEvent(event) });
            }
          }}
          onPointerUp={finishAreaDrag}
          onPointerCancel={() => {
            setDragActive(false);
            setAreaDrag(null);
          }}
        >
          <video
            ref={videoRef}
            src={video.url}
            muted
            playsInline
            className="h-full w-full object-contain"
          />

          {trackedBox !== null && followed !== undefined ? (
            <div
              aria-hidden="true"
              style={{
                left: `${trackedBox.left}%`,
                top: `${trackedBox.top}%`,
                width: `${trackedBox.width}%`,
                height: `${trackedBox.height}%`,
              }}
              className="pointer-events-none absolute border-2 border-accent transition-[left,top,width,height] duration-200 ease-linear motion-reduce:transition-none"
            >
              <span className="absolute top-0 left-0 bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-ink">
                {followed.label}
              </span>
            </div>
          ) : null}

          {areaDrag !== null && (dragActive || areaBusy) ? (
            <div
              className="pointer-events-none absolute rounded-xs border border-accent bg-accent/15"
              style={{
                left: Math.min(areaDrag.start.x, areaDrag.end.x),
                top: Math.min(areaDrag.start.y, areaDrag.end.y),
                width: Math.abs(areaDrag.end.x - areaDrag.start.x),
                height: Math.abs(areaDrag.end.y - areaDrag.start.y),
              }}
            />
          ) : null}

          {hint !== null ? (
            <span className="pointer-events-none absolute top-2.5 left-3 rounded-full bg-bg/80 px-2.5 py-0.5 text-xs text-text">
              {hint}
            </span>
          ) : null}
        </div>

        {followed !== undefined && followed.visible.length > 0 ? (
          <div
            className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-inset"
            role="img"
            aria-label={`When ${followed.label} is on screen`}
          >
            {followed.visible.map(([start, end], index) => (
              <div
                key={index}
                style={{
                  left: `${onScreenPercent(start)}%`,
                  width: `${Math.max(1, onScreenPercent(end - start))}%`,
                }}
                className="absolute inset-y-0 bg-accent/60"
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
