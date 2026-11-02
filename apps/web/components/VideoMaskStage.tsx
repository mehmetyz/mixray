"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  areaAroundPaths,
  areaAtTime,
  areaOnStage,
  easeStageBox,
  MIN_DRAG_PIXELS,
  videoAreaFromDrag,
  type PixelSize,
  type StageBox,
  type TimedArea,
  type VideoArea,
} from "@/lib/studio/area";
import { useStageDrag, type StageDrag } from "@/lib/studio/use-stage-drag";
import type { Video } from "@/lib/trackmap/trackmap.generated";
import { useStudio } from "./StudioContext";
import { TrackedCorners } from "./TrackedCorners";

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

// The name is only needed to say what the corners mark, not to sit on the picture.
const TRACKED_NAME_MS = 2200;
// The stage below is `aspect-video`.
const STAGE_SIZE: PixelSize = { width: 16, height: 9 };

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

export function VideoMaskStage({
  video,
  onSelectArea,
  areaBusy = false,
  followedTrackId,
  sizeClass,
}: VideoMaskStageProps) {
  const { currentTime, duration, getPlaybackTime, playing, ratePercent, togglePlay } = useStudio();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [maskFrames, setMaskFrames] = useState<{ id: string; frames: MaskFrame[] } | null>(null);
  const trackedBoxRef = useRef<HTMLDivElement | null>(null);
  const trackedNameRef = useRef<HTMLSpanElement | null>(null);
  const [areaDrag, setAreaDrag] = useState<StageDrag | null>(null);
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

  const beginDrag = useStageDrag({
    onChange: (drag) => {
      setAreaDrag(drag);
      setDragActive(drag !== null);
    },
    onFinish: ({ start, end }, stage) => {
      setDragActive(false);
      if (onSelectArea === undefined) return;
      if (Math.hypot(end.x - start.x, end.y - start.y) < MIN_DRAG_PIXELS) {
        setAreaDrag(null);
        togglePlay();
        return;
      }
      setAreaDrag({ start, end });
      if (playing) togglePlay();
      const lastFrame = Math.max(0, Math.floor(duration * fps) - 1);
      onSelectArea(
        videoAreaFromDrag(
          start,
          end,
          { width: stage.width, height: stage.height },
          { width: video.width, height: video.height },
        ),
        Math.min(lastFrame, Math.round(getPlaybackTime() * fps)),
      );
    },
  });

  const trackedAreas = useMemo<TimedArea[]>(() => {
    if (followed === undefined || maskFrames?.id !== followed.id) return [];
    const areas: TimedArea[] = [];
    for (const frame of maskFrames.frames) {
      const area = areaAroundPaths(frame.paths);
      if (area !== null) areas.push({ time: frame.frame / fps, area });
    }
    return areas;
  }, [followed, maskFrames, fps]);

  // Every drawn frame rather than on React's clock, or the box would step behind the picture.
  useEffect(() => {
    if (trackedAreas.length === 0) return;
    const size = { width: video.width, height: video.height };
    let shown: StageBox | null = null;
    let shownSince = 0;
    let lastDraw = performance.now();
    let request = requestAnimationFrame(function draw(now) {
      const box = trackedBoxRef.current;
      const name = trackedNameRef.current;
      const area = areaAtTime(trackedAreas, getPlaybackTime());
      if (area === null) {
        shown = null;
      } else {
        const target = areaOnStage(area, size, STAGE_SIZE);
        if (shown === null) shownSince = now;
        shown = shown === null ? target : easeStageBox(shown, target, now - lastDraw);
      }
      lastDraw = now;
      if (box !== null) {
        box.style.opacity = shown === null ? "0" : "1";
        if (shown !== null) {
          box.style.left = `${shown.left}%`;
          box.style.top = `${shown.top}%`;
          box.style.width = `${shown.width}%`;
          box.style.height = `${shown.height}%`;
        }
      }
      if (name !== null) name.style.opacity = shown !== null && now - shownSince < TRACKED_NAME_MS ? "1" : "0";
      request = requestAnimationFrame(draw);
    });
    return () => cancelAnimationFrame(request);
  }, [trackedAreas, getPlaybackTime, video.width, video.height]);

  const hint =
    onSelectArea !== undefined
      ? areaBusy
        ? "Finding that sound"
        : "Drag over a sound"
      : followed !== undefined && trackedAreas.length === 0
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
            beginDrag(event);
          }}
        >
          <video
            ref={videoRef}
            src={video.url}
            muted
            playsInline
            className="h-full w-full object-contain"
          />

          {followed !== undefined && trackedAreas.length > 0 ? (
            <div
              ref={trackedBoxRef}
              aria-hidden="true"
              className="pointer-events-none absolute opacity-0 shadow-[0_0_0_100vmax_rgb(0_0_0/0.3)] transition-opacity duration-300 motion-reduce:transition-none"
            >
              <TrackedCorners />
              <span
                ref={trackedNameRef}
                className="absolute top-1.5 left-2 rounded-full bg-bg/80 px-2 py-0.5 text-xs text-text opacity-0 transition-opacity duration-500 motion-reduce:transition-none"
              >
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
