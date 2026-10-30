"use client";

import { useEffect, useMemo, useRef, type PointerEvent } from "react";
import type { StemName } from "@/lib/audio/player";
import { drawWaveformLane } from "@/lib/studio/canvas";
import { deriveMixPeaks, methodBadgeLabel } from "@/lib/studio/format";
import { useStudio } from "./StudioContext";
import { useThemeListener } from "./ThemeToggle";

type SingleLaneProps = {
  title: string;
  subtitle: string;
  stem: StemName;
  peaks: number[];
  audible: boolean;
  tone: "accent" | "rest";
  showAccentDot?: boolean;
};

function WaveformLaneRow({
  title,
  subtitle,
  stem,
  peaks,
  audible,
  tone,
  showAccentDot = false,
}: SingleLaneProps) {
  const { currentTime, duration, trackMap, monitor, setMonitor, loopRange, seek } = useStudio();
  const themeTick = useThemeListener();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef<boolean>(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    drawWaveformLane({
      canvas,
      peaks,
      currentTime,
      duration,
      downbeats: trackMap.downbeats,
      audible,
      tone,
      loop: loopRange,
    });
  }, [peaks, currentTime, duration, trackMap.downbeats, audible, tone, loopRange, themeTick]);

  const scrubAtClientX = (clientX: number, element: HTMLElement) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    seek(ratio * duration);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubAtClientX(event.clientX, event.currentTarget);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    scrubAtClientX(event.clientX, event.currentTarget);
  };

  const onPointerUp = () => {
    draggingRef.current = false;
  };

  const isSolo = monitor === stem;

  return (
    <div className="flex h-20 items-stretch border-b border-line">
      <div className="flex w-28 shrink-0 flex-col justify-between border-r border-line bg-surface p-2.5 sm:w-36">
        <div className="flex items-center justify-between gap-1">
          <span className="flex min-w-0 items-center gap-1.5 truncate text-xs font-medium text-text">
            {showAccentDot ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" /> : null}
            <span className="truncate">{title}</span>
          </span>
          <button
            type="button"
            aria-label={`Solo ${title}`}
            aria-pressed={isSolo}
            onClick={() => setMonitor(stem)}
            className={`mono-num shrink-0 cursor-pointer rounded-icon border px-1.5 py-0.5 text-[10px] transition ${
              isSolo
                ? "border-text bg-text font-semibold text-bg"
                : "border-line-2 text-muted hover:border-control hover:text-text"
            }`}
          >
            S
          </button>
        </div>
        <span className="mono-num truncate text-[11px] text-muted">{subtitle}</span>
      </div>

      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative flex-1 cursor-pointer touch-none bg-inset"
      >
        <canvas
          ref={canvasRef}
          width={960}
          height={80}
          role="img"
          aria-label={`${title} waveform (${audible ? "audible" : "muted"})`}
          className="h-full w-full block"
        />
      </div>
    </div>
  );
}

export function WaveformLanes() {
  const { selectedIsolation, useDemucsCleaner, monitor } = useStudio();

  const soundPeaks = useMemo(
    () => selectedIsolation?.peaks ?? [0.25, 0.45, 0.35, 0.6, 0.5, 0.7, 0.55, 0.4],
    [selectedIsolation],
  );
  const restPeaks = useMemo(
    () => selectedIsolation?.rest_peaks ?? [0.55, 0.4, 0.42, 0.4, 0.55, 0.4, 0.42, 0.4],
    [selectedIsolation],
  );
  const mixPeaks = useMemo(() => deriveMixPeaks(soundPeaks, restPeaks), [soundPeaks, restPeaks]);

  const soundSubtitle =
    selectedIsolation !== undefined
      ? methodBadgeLabel(selectedIsolation.method, useDemucsCleaner)
      : "No sound picked yet";

  return (
    <div className="divide-y-0">
      <WaveformLaneRow
        title="Full mix"
        subtitle="Original clip"
        stem="mix"
        peaks={mixPeaks}
        audible={monitor === "mix"}
        tone="rest"
      />
      <WaveformLaneRow
        title={selectedIsolation?.label ?? "Picked sound"}
        subtitle={soundSubtitle}
        stem="sound"
        peaks={soundPeaks}
        audible={monitor === "sound" || monitor === "mix"}
        tone="accent"
        showAccentDot
      />
      <WaveformLaneRow
        title="Rest of mix"
        subtitle="Residual backing"
        stem="rest"
        peaks={restPeaks}
        audible={monitor === "rest" || monitor === "mix"}
        tone="rest"
      />
    </div>
  );
}

