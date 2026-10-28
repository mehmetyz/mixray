"use client";

import { useEffect, useRef } from "react";
import type { TimeRange, Video, VideoTrack } from "@/lib/trackmap/trackmap.generated";
import { useStudio } from "./StudioContext";

export type QuartetMaskTarget = {
  id: string;
  label: string;
  prompt: string;
  positionClass: string;
  visible: TimeRange[];
};

type VideoMaskStageProps = {
  video?: Video;
  demoQuartetMode: boolean;
  selectedTargetId: string;
  onSelectTarget: (targetId: string, prompt: string, label: string, isolationId?: string) => void;
};

export const QUARTET_DEMO_TARGETS: readonly QuartetMaskTarget[] = [
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

function trackPositionClass(index: number): string {
  const presets = [
    "left-[6%] top-[18%] w-[22%] h-[66%]",
    "left-[32%] top-[20%] w-[22%] h-[64%]",
    "left-[58%] top-[22%] w-[22%] h-[62%]",
    "left-[78%] top-[18%] w-[16%] h-[68%]",
  ];
  return presets[index % presets.length] ?? presets[0] ?? "";
}

function toStageTargets(video: Video | undefined): QuartetMaskTarget[] {
  if (video === undefined) return [...QUARTET_DEMO_TARGETS];
  return video.tracks.map((track: VideoTrack, idx: number) => ({
    id: track.id,
    label: track.label,
    prompt: track.prompt ?? track.label.toLowerCase(),
    positionClass: trackPositionClass(idx),
    visible: track.visible,
  }));
}

export function VideoMaskStage({
  video,
  demoQuartetMode,
  selectedTargetId,
  onSelectTarget,
}: VideoMaskStageProps) {
  const { currentTime, duration, playing } = useStudio();
  const videoRef = useRef<HTMLVideoElement | null>(null);

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

  if (video === undefined && !demoQuartetMode) {
    return null;
  }

  const targets = toStageTargets(video);
  const activeTarget = targets.find((item) => item.id === selectedTargetId) ?? targets[0];
  const playPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  return (
    <div className="border-b border-line">
      <div className="p-4">
        <div className="mx-auto max-w-4xl space-y-2">
          <div className="relative aspect-[21/9] w-full overflow-hidden rounded-well border border-line bg-inset select-none">
            {video !== undefined ? (
              <video
                ref={videoRef}
                src={video.url}
                muted
                playsInline
                className="h-full w-full object-cover opacity-55"
              />
            ) : (
              <div className="pointer-events-none absolute inset-0 flex items-end justify-between px-10 pb-3 opacity-25">
                <div className="h-px w-full bg-line-2" />
              </div>
            )}

            {targets.map((target) => {
              const selected = target.id === activeTarget?.id;
              const matchedTrack = video?.tracks.find((t) => t.id === target.id);
              return (
                <button
                  key={target.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    onSelectTarget(
                      target.id,
                      target.prompt,
                      target.label,
                      matchedTrack?.isolation_id,
                    )
                  }
                  className={`absolute flex cursor-pointer flex-col justify-between rounded-icon p-2.5 text-left transition ${target.positionClass} ${
                    selected
                      ? "border border-accent bg-surface-2/65"
                      : "border border-dashed border-control bg-bg/55 hover:border-text-2"
                  }`}
                >
                  <span
                    className={`mono-num inline-flex items-center gap-1.5 self-start rounded-icon px-2 py-0.5 text-xs font-medium ${
                      selected ? "bg-text text-bg" : "bg-surface-2 text-text-2"
                    }`}
                  >
                    {selected ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
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

      {activeTarget !== undefined ? (
        <div className="flex h-7 items-center border-t border-line bg-surface">
          <div className="mono-num w-28 shrink-0 border-r border-line px-3 text-[11px] text-muted sm:w-36">
            ON SCREEN
          </div>
          <div className="relative h-full flex-1 bg-inset">
            {activeTarget.visible.map(([start, end], index) => {
              const left = duration > 0 ? (start / duration) * 100 : 0;
              const width = duration > 0 ? Math.max(2, ((end - start) / duration) * 100) : 100;
              return (
                <div
                  key={index}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  className="mono-num absolute inset-y-1.5 flex items-center rounded-xs border border-control bg-surface-2 px-2 text-[10px] text-text-2"
                >
                  {activeTarget.label} visible ({start.toFixed(0)}s–{end.toFixed(0)}s)
                </div>
              );
            })}
            <div
              style={{ left: `${playPercent}%` }}
              className="pointer-events-none absolute top-0 bottom-0 w-[1.5px] bg-text"
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

