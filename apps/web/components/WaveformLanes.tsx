"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import type { StemName } from "@/lib/audio/player";
import { drawWaveformLane } from "@/lib/studio/canvas";
import { deriveMixPeaks, formatClockSeconds } from "@/lib/studio/format";
import { useStudio } from "./StudioContext";
import { useThemeListener } from "./ThemeToggle";

type SingleLaneProps = {
  title: string;
  stem: StemName;
  peaks: number[];
  audible: boolean;
  tone: "accent" | "rest";
  showAccentDot?: boolean;
};

function WaveformLaneRow({
  title,
  stem,
  peaks,
  audible,
  tone,
  showAccentDot = false,
}: SingleLaneProps) {
  const { currentTime, duration, trackMap, monitor, setMonitor, loopRange, seek } =
    useStudio();
  const themeTick = useThemeListener();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRef = useRef<boolean>(false);

  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: 1200,
    height: 104,
  });
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);

  // ResizeObserver for razor-sharp Retina/4K rendering at any viewport width
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        setCanvasSize({
          width: Math.round(width),
          height: Math.round(height),
        });
      }
    });

    ro.observe(container);
    return () => ro.disconnect();
  }, []);

  // Redraw whenever peaks, time, size, audio state or theme changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;

    const targetW = Math.round(canvasSize.width * dpr);
    const targetH = Math.round(canvasSize.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    drawWaveformLane({
      canvas,
      peaks,
      currentTime,
      duration,
      downbeats: trackMap.downbeats,
      audible,
      tone,
      loop: loopRange,
      dpr,
    });
  }, [
    peaks,
    currentTime,
    duration,
    trackMap.downbeats,
    audible,
    tone,
    loopRange,
    themeTick,
    canvasSize,
  ]);

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
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width > 0) {
      const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      setHoverRatio(ratio);
    }
    if (!draggingRef.current) return;
    scrubAtClientX(event.clientX, event.currentTarget);
  };

  const onPointerUp = () => {
    draggingRef.current = false;
  };

  const onPointerLeave = () => {
    if (!draggingRef.current) {
      setHoverRatio(null);
    }
  };

  const isSolo = monitor === stem;
  const hoverTime = hoverRatio !== null ? hoverRatio * duration : 0;

  return (
    <div className="group/lane relative flex h-24 sm:h-27 items-stretch border-b border-line/70 bg-surface/30 transition-colors hover:bg-surface/50">
      {/* Left Track Mixer & Info Strip */}
      <div className="flex w-36 sm:w-48 shrink-0 flex-col justify-between border-r border-line bg-surface/80 p-2.5 sm:p-3 backdrop-blur-xs select-none">
        {/* Track Title, Stem Icon & Activity */}
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-1.5">
            <span className="flex min-w-0 items-center gap-1.5 truncate text-xs sm:text-sm font-semibold tracking-tight text-text">
              {showAccentDot ? (
                <span className="relative flex h-2 w-2 shrink-0">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-accent shadow-xs shadow-accent/60" />
                </span>
              ) : (
                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-text-2/40" />
              )}
              <span className="truncate">{title}</span>
            </span>

          </div>

        </div>

        {/* Solo */}
        <div className="flex items-center">
          <div className="flex items-center gap-1">
            {/* Solo Button */}
            <button
              type="button"
              aria-label={`Solo ${title}`}
              aria-pressed={isSolo}
              onClick={(e) => {
                e.stopPropagation();
                setMonitor(isSolo ? "mix" : stem);
              }}
              className={`mono-num flex h-5.5 w-6 cursor-pointer items-center justify-center rounded-xs text-[10px] font-bold transition ${
                isSolo
                  ? "bg-accent text-accent-ink shadow-xs shadow-accent/50 scale-105"
                  : "bg-surface-2/80 text-muted hover:border-control hover:bg-surface-2 hover:text-text"
              }`}
              title={isSolo ? "Deactivate Solo (play full mix)" : `Solo ${title}`}
            >
              S
            </button>

          </div>
        </div>
      </div>

      {/* Center Waveform Canvas Area */}
      <div
        ref={containerRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
        className="relative flex-1 cursor-crosshair touch-none bg-inset/50 overflow-hidden"
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={`${title} waveform (${audible ? "audible" : "muted"})`}
          style={{ width: `${canvasSize.width}px`, height: `${canvasSize.height}px` }}
          className="block h-full w-full pointer-events-none"
        />

        {/* Floating Hover Timeline Guide & Timestamp Bubble */}
        {hoverRatio !== null ? (
          <div
            style={{ left: `${hoverRatio * 100}%` }}
            className="pointer-events-none absolute inset-y-0 z-20 flex flex-col items-center"
          >
            <div className="mono-num -mt-0.5 rounded-full border border-line-2 bg-text px-1.5 py-0.2 text-[9px] font-semibold text-bg shadow-sm">
              {formatClockSeconds(hoverTime)}
            </div>
            <div className="w-px flex-1 border-r border-dashed border-text/40" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function WaveformLanes() {
  const { selectedIsolation, monitor } = useStudio();
  const soundPeaks = selectedIsolation?.peaks;
  const restPeaks = selectedIsolation?.rest_peaks;
  const mixPeaks = useMemo(
    () => (soundPeaks === undefined ? [] : deriveMixPeaks(soundPeaks, restPeaks)),
    [soundPeaks, restPeaks],
  );

  if (selectedIsolation === undefined || soundPeaks === undefined) return null;

  return (
    <div className="flex w-full flex-col border-b border-line bg-surface/20">
      <WaveformLaneRow
        title={selectedIsolation.label}
        stem="sound"
        peaks={soundPeaks}
        audible={monitor === "sound" || monitor === "mix"}
        tone="accent"
        showAccentDot
      />
      <WaveformLaneRow
        title="Rest of the mix"
        stem="rest"
        peaks={restPeaks ?? []}
        audible={monitor === "rest" || monitor === "mix"}
        tone="rest"
      />
      <WaveformLaneRow
        title="Full mix"
        stem="mix"
        peaks={mixPeaks}
        audible={monitor === "mix"}
        tone="rest"
      />
    </div>
  );
}
