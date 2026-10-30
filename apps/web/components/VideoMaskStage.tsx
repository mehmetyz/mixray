"use client";

import { useEffect, useRef, useState } from "react";
import type { TimeRange, Video, VideoTrack } from "@/lib/trackmap/trackmap.generated";
import { useStudio } from "./StudioContext";

export interface MaskTarget {
  id: string;
  label: string;
  prompt: string;
  positionClass: string;
  visible: TimeRange[];
  masksUrl?: string;
  isolationId?: string;
}

export interface MaskFrame {
  frame: number;
  time: number;
  paths: string[];
}

export interface VideoMaskStageProps {
  video?: Video;
  demoQuartetMode: boolean;
  selectedTargetId: string;
  onSelectTarget: (targetId: string, prompt: string, label: string, isolationId?: string) => void;
}

export const QUARTET_DEMO_TARGETS: readonly MaskTarget[] = [
  {
    id: "violin",
    label: "Violin",
    prompt: "supersaw synth lead",
    positionClass: "left-[5%] top-[18%] w-[20%] h-[68%]",
    visible: [[0, 30]],
  },
  {
    id: "cello",
    label: "Cello",
    prompt: "sub bass",
    positionClass: "left-[28%] top-[22%] w-[20%] h-[64%]",
    visible: [[0, 30]],
  },
  {
    id: "piano",
    label: "Piano",
    prompt: "piano chords",
    positionClass: "left-[51%] top-[25%] w-[23%] h-[60%]",
    visible: [[0, 30]],
  },
  {
    id: "vocals",
    label: "Vocals",
    prompt: "vocal chops",
    positionClass: "left-[77%] top-[16%] w-[17%] h-[70%]",
    visible: [[15, 30]],
  },
];

const DEMO_QUARTET_SVG_PATHS: Record<string, string> = {
  violin:
    "M 140 130 C 170 120 210 130 220 170 C 225 190 210 220 190 240 C 230 290 245 350 240 420 C 235 480 200 540 150 550 C 100 540 70 480 75 420 C 85 350 110 300 130 260 C 110 230 110 180 140 130 Z",
  cello:
    "M 460 160 C 500 150 540 170 550 220 C 555 250 535 290 510 320 C 560 380 575 470 565 540 C 555 600 510 630 460 630 C 410 630 370 590 365 530 C 360 460 385 390 420 330 C 390 290 380 240 410 190 Z",
  piano:
    "M 680 200 L 910 200 L 930 260 L 930 520 L 890 580 L 870 580 L 870 450 L 730 450 L 730 580 L 700 580 L 670 480 Z",
  vocals:
    "M 1070 140 C 1110 135 1140 160 1145 200 C 1150 230 1135 260 1120 280 C 1160 330 1180 400 1175 480 C 1170 530 1135 560 1085 560 C 1035 560 1000 520 1000 460 C 1000 390 1025 320 1050 280 C 1030 250 1030 200 1070 140 Z",
};

function trackPositionClass(index: number): string {
  const presets = [
    "left-[6%] top-[18%] w-[22%] h-[66%]",
    "left-[32%] top-[20%] w-[22%] h-[64%]",
    "left-[58%] top-[22%] w-[22%] h-[62%]",
    "left-[78%] top-[18%] w-[16%] h-[68%]",
  ];
  return presets[index % presets.length] ?? presets[0] ?? "";
}

function generateFallbackPolygon(index: number, width: number, height: number): string {
  const horizontalPositions = [
    { xRatio: 0.06, yRatio: 0.18, wRatio: 0.22, hRatio: 0.66 },
    { xRatio: 0.32, yRatio: 0.20, wRatio: 0.22, hRatio: 0.64 },
    { xRatio: 0.58, yRatio: 0.22, wRatio: 0.22, hRatio: 0.62 },
    { xRatio: 0.78, yRatio: 0.18, wRatio: 0.16, hRatio: 0.68 },
  ];
  const pos = horizontalPositions[index % horizontalPositions.length] ?? horizontalPositions[0];
  const x = Math.round(width * (pos?.xRatio ?? 0.1));
  const y = Math.round(height * (pos?.yRatio ?? 0.2));
  const w = Math.round(width * (pos?.wRatio ?? 0.2));
  const h = Math.round(height * (pos?.hRatio ?? 0.6));
  const rx = Math.round(w * 0.1);
  const ry = Math.round(h * 0.08);

  return `M ${x + rx} ${y} L ${x + w - rx} ${y} Q ${x + w} ${y} ${x + w} ${y + ry} L ${x + w} ${y + h - ry} Q ${x + w} ${y + h} ${x + w - rx} ${y + h} L ${x + rx} ${y + h} Q ${x} ${y + h} ${x} ${y + h - ry} L ${x} ${y + ry} Q ${x} ${y} ${x + rx} ${y} Z`;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseMaskFrames(json: unknown, fps: number): MaskFrame[] {
  if (json === null || typeof json !== "object") return [];

  let rawFrames: unknown[] | null = null;
  if (isObjectRecord(json) && "frames" in json && Array.isArray(json.frames)) {
    rawFrames = json.frames;
  } else if (Array.isArray(json)) {
    rawFrames = json;
  }

  if (rawFrames === null) return [];

  const parsed: MaskFrame[] = [];
  const safeFps = fps > 0 ? fps : 10;

  for (let i = 0; i < rawFrames.length; i++) {
    const raw = rawFrames[i];
    if (!isObjectRecord(raw)) continue;

    const frameIndex = typeof raw.frame === "number" ? raw.frame : i;
    const time =
      typeof raw.time === "number" ? raw.time : Number((frameIndex / safeFps).toFixed(3));

    const paths: string[] = [];

    if (Array.isArray(raw.paths)) {
      for (const p of raw.paths) {
        if (typeof p === "string" && p.trim().length > 0) {
          paths.push(p.trim());
        }
      }
    }

    if (Array.isArray(raw.polygons)) {
      for (const poly of raw.polygons) {
        if (Array.isArray(poly) && poly.length >= 3) {
          const coords: string[] = [];
          for (let ptIdx = 0; ptIdx < poly.length; ptIdx++) {
            const pt = poly[ptIdx];
            if (
              Array.isArray(pt) &&
              pt.length >= 2 &&
              typeof pt[0] === "number" &&
              typeof pt[1] === "number"
            ) {
              const cmd = ptIdx === 0 ? "M" : "L";
              coords.push(`${cmd}${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`);
            }
          }
          if (coords.length >= 3) {
            paths.push(`${coords.join(" ")} Z`);
          }
        }
      }
    }

    if (paths.length > 0) {
      parsed.push({ frame: frameIndex, time, paths });
    }
  }

  return parsed;
}

function isTimeInRanges(time: number, ranges: readonly TimeRange[]): boolean {
  if (ranges.length === 0) return true;
  return ranges.some(([start, end]) => time >= start && time <= end);
}

function toStageTargets(video: Video | undefined): MaskTarget[] {
  if (video === undefined) return [...QUARTET_DEMO_TARGETS];
  return video.tracks.map((track: VideoTrack, idx: number) => ({
    id: track.id,
    label: track.label,
    prompt: track.prompt ?? track.label.toLowerCase(),
    positionClass: trackPositionClass(idx),
    visible: track.visible,
    masksUrl: track.masks_url,
    isolationId: track.isolation_id,
  }));
}

export function VideoMaskStage({
  video,
  demoQuartetMode,
  selectedTargetId,
  onSelectTarget,
}: VideoMaskStageProps) {
  const { currentTime, duration, playing, togglePlay } = useStudio();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [masksByTrack, setMasksByTrack] = useState<Record<string, MaskFrame[]>>({});

  const stageWidth = video?.width && video.width > 0 ? video.width : 1280;
  const stageHeight = video?.height && video.height > 0 ? video.height : 720;
  const videoFps = video?.fps && video.fps > 0 ? video.fps : 10;

  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    if (Math.abs(el.currentTime - currentTime) > 0.25) {
      el.currentTime = currentTime;
    }
  }, [currentTime]);

  useEffect(() => {
    const el = videoRef.current;
    if (el === null) return;
    if (playing) {
      void el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [playing]);

  useEffect(() => {
    if (video === undefined) return;

    let isMounted = true;
    const fetchAllMasks = async () => {
      const results: Record<string, MaskFrame[]> = {};

      for (const track of video.tracks) {
        if (!track.masks_url || track.masks_url.trim().length === 0) continue;
        try {
          const res = await fetch(track.masks_url);
          if (res.ok) {
            const json: unknown = await res.json();
            const parsed = parseMaskFrames(json, videoFps);
            if (parsed.length > 0) {
              results[track.id] = parsed;
            }
          }
        } catch {
          // Graceful fallback to position polygons if fetch fails
        }
      }

      if (isMounted) {
        setMasksByTrack(results);
      }
    };

    void fetchAllMasks();

    return () => {
      isMounted = false;
    };
  }, [video, videoFps]);

  if (video === undefined && !demoQuartetMode) {
    return null;
  }

  const targets = toStageTargets(video);
  const activeTarget = targets.find((item) => item.id === selectedTargetId) ?? targets[0];
  const playPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;
  const hasSelection = selectedTargetId.length > 0;

  const getTrackPaths = (track: MaskTarget, index: number): string[] => {
    const loadedFrames = masksByTrack[track.id];
    if (loadedFrames !== undefined && loadedFrames.length > 0) {
      const targetFrame = Math.round(currentTime * videoFps);
      let closest = loadedFrames[0];
      let minDiff = Math.abs((closest?.frame ?? 0) - targetFrame);

      for (let i = 1; i < loadedFrames.length; i++) {
        const candidate = loadedFrames[i];
        if (candidate === undefined) continue;
        const diff = Math.abs(candidate.frame - targetFrame);
        if (diff < minDiff) {
          minDiff = diff;
          closest = candidate;
        }
      }

      if (closest !== undefined && closest.paths.length > 0) {
        return closest.paths;
      }
    }

    const demoPath = DEMO_QUARTET_SVG_PATHS[track.id];
    if (demoPath !== undefined) {
      return [demoPath];
    }

    return [generateFallbackPolygon(index, stageWidth, stageHeight)];
  };

  return (
    <div className="border-b border-line bg-bg">
      <div className="p-3 md:p-4">
        <div className="mx-auto max-w-4xl space-y-2">
          {/* Main Video Viewport (16:9 standard) */}
          <div
            className="group relative aspect-video w-full overflow-hidden rounded-well border border-line bg-inset select-none"
            onClick={togglePlay}
          >
            {video !== undefined ? (
              <video
                ref={videoRef}
                src={video.url}
                muted
                playsInline
                className={`h-full w-full object-cover transition-opacity duration-300 ${
                  hasSelection ? "opacity-60 brightness-90" : "opacity-80"
                }`}
              />
            ) : (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-30">
                <div className="mono-num text-xs text-muted">QUARTET PREVIEW · NO VIDEO SOURCE</div>
              </div>
            )}

            {/* SVG Mask Overlay */}
            <svg
              viewBox={`0 0 ${stageWidth} ${stageHeight}`}
              className="pointer-events-none absolute inset-0 h-full w-full"
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
            >
              <defs>
                <filter id="accent-mask-glow" x="-10%" y="-10%" width="120%" height="120%">
                  <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="#7DD3EE" floodOpacity="0.75" />
                </filter>
              </defs>

              {targets.map((target, idx) => {
                const isSelected = target.id === selectedTargetId;
                const isVisible = isTimeInRanges(currentTime, target.visible);
                if (!isVisible) return null;

                const paths = getTrackPaths(target, idx);

                return paths.map((pathString, pathIdx) => (
                  <path
                    key={`${target.id}-${pathIdx}`}
                    d={pathString}
                    role="button"
                    tabIndex={0}
                    aria-label={`${target.label} (${isSelected ? "Selected mask" : "Mask"})`}
                    aria-pressed={isSelected}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectTarget(target.id, target.prompt, target.label, target.isolationId);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        e.stopPropagation();
                        onSelectTarget(target.id, target.prompt, target.label, target.isolationId);
                      }
                    }}
                    filter={isSelected ? "url(#accent-mask-glow)" : undefined}
                    className={`pointer-events-auto cursor-pointer transition-all duration-150 focus:outline-none ${
                      isSelected
                        ? "fill-[#7DD3EE]/40 stroke-[#7DD3EE]"
                        : hasSelection
                          ? "fill-white/[0.04] stroke-white/25 opacity-40 hover:fill-[#7DD3EE]/20 hover:stroke-[#7DD3EE]/80 hover:opacity-100"
                          : "fill-white/[0.08] stroke-white/50 hover:fill-[#7DD3EE]/20 hover:stroke-[#7DD3EE]/80"
                    }`}
                    strokeWidth={isSelected ? 3 : 1.5}
                    strokeDasharray={isSelected ? undefined : "6 4"}
                    strokeLinejoin="round"
                  />
                ));
              })}
            </svg>

            {/* Top HUD bar */}
            <div className="pointer-events-none absolute top-2.5 right-3 left-3 flex items-center justify-between">
              <span className="mono-num inline-flex items-center gap-1.5 rounded-full border border-line-2 bg-surface/85 px-2.5 py-0.5 text-[10px] font-medium text-text-2 backdrop-blur-xs">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                SAM 3.1 TRACKING {activeTarget ? `· ${activeTarget.label.toUpperCase()}` : ""}
              </span>
              <span className="mono-num rounded-full border border-line-2 bg-surface/85 px-2 py-0.5 text-[10px] text-muted backdrop-blur-xs">
                {playing ? "PLAYING" : "PAUSED"}
              </span>
            </div>

            {/* Interactive Target Buttons / Badges */}
            {targets.map((target) => {
              const selected = target.id === selectedTargetId;
              const isVisible = isTimeInRanges(currentTime, target.visible);

              return (
                <button
                  key={target.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectTarget(target.id, target.prompt, target.label, target.isolationId);
                  }}
                  className={`absolute flex cursor-pointer flex-col justify-between rounded-icon p-2 text-left transition-all duration-150 ${target.positionClass} ${
                    !isVisible
                      ? "pointer-events-none opacity-0"
                      : selected
                        ? "border border-accent bg-surface-2/80 shadow-md shadow-accent/10"
                        : hasSelection
                          ? "border border-dashed border-control/40 bg-bg/35 opacity-45 hover:border-control hover:opacity-90"
                          : "border border-dashed border-control bg-bg/55 hover:border-text-2"
                  }`}
                >
                  <span
                    className={`mono-num inline-flex items-center gap-1.5 self-start rounded-icon px-2 py-0.5 text-xs font-medium transition ${
                      selected ? "bg-text text-bg shadow-xs" : "bg-surface-2 text-text-2"
                    }`}
                  >
                    {selected ? <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" /> : null}
                    {target.label}
                  </span>
                  <span className="mono-num text-[10px] text-muted">
                    {selected ? "SAM 3.1 · SELECTED" : "Tap to isolate"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* On-Screen Visibility Lane */}
      {activeTarget !== undefined ? (
        <div className="flex h-8 items-center border-t border-line bg-surface">
          <div className="mono-num flex w-36 shrink-0 items-center justify-between border-r border-line px-3 text-[11px] font-medium text-muted sm:w-48">
            <span>ON SCREEN</span>
            <span className="mono-num text-[10px] font-semibold text-accent uppercase">{activeTarget.label}</span>
          </div>
          <div className="relative h-full flex-1 overflow-hidden bg-inset">
            {activeTarget.visible.map(([start, end], index) => {
              const left = duration > 0 ? (start / duration) * 100 : 0;
              const width = duration > 0 ? Math.max(1, ((end - start) / duration) * 100) : 100;
              return (
                <div
                  key={index}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  className="mono-num absolute inset-y-1 flex items-center rounded-xs border border-accent/40 bg-accent/15 px-2 text-[10px] font-medium text-accent shadow-xs"
                >
                  {activeTarget.label} visible ({start.toFixed(1)}s–{end.toFixed(1)}s)
                </div>
              );
            })}
            <div
              style={{ left: `${playPercent}%` }}
              className="pointer-events-none absolute top-0 bottom-0 w-[1.5px] bg-text shadow-sm"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
