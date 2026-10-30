"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import type { StemName } from "@/lib/audio/player";
import type { ClipStepId, NavState } from "@/lib/steps";
import { formatBarBeat, formatClockSeconds } from "@/lib/studio/format";
import { AppHeader } from "./AppHeader";
import { useStudio } from "./StudioContext";

type TimelineRulerProps = {
  rightSlot?: ReactNode;
};

type AddShellProps = {
  center: ReactNode;
  inspector: ReactNode;
};

type StudioShellProps = {
  children: ReactNode;
};

type MonitorOption = {
  id: StemName;
  label: string;
  keyHint: string;
};

const MONITOR_OPTIONS: readonly MonitorOption[] = [
  { id: "sound", label: "Sound", keyHint: "1" },
  { id: "rest", label: "Rest", keyHint: "2" },
  { id: "mix", label: "Full mix", keyHint: "3" },
];

function detectStepFromPath(pathname: string | null): ClipStepId {
  if (pathname?.endsWith("/xray") === true) return "xray";
  if (pathname?.endsWith("/learn") === true) return "learn";
  if (pathname?.endsWith("/take") === true) return "take";
  return "pick";
}

/** Shared bar and time ruler at the top of the Center DAW workspace; click anywhere to scrub. */
export function TimelineRuler({ rightSlot }: TimelineRulerProps) {
  const { trackMap, currentTime, duration, loopRange, seek } = useStudio();
  const barCount = Math.max(1, trackMap.downbeats.length || 16);
  const playPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0;

  const loopStyle =
    loopRange !== null && duration > 0
      ? {
          left: `${(loopRange.startSeconds / duration) * 100}%`,
          width: `${Math.max(2, ((loopRange.endSeconds - loopRange.startSeconds) / duration) * 100)}%`,
        }
      : null;

  const handleScrub = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seek(ratio * duration);
  };

  return (
    <div className="flex h-9 shrink-0 select-none items-center border-b border-line bg-surface/90">
      <div className="mono-num flex w-36 shrink-0 items-center justify-between border-r border-line px-3 text-xs text-muted sm:w-48">
        <span className="text-[11px] font-medium tracking-wide">BARS</span>
        <span className="font-semibold text-text">{formatClockSeconds(currentTime)}</span>
      </div>
      <div
        role="slider"
        tabIndex={0}
        aria-label="Clip timeline position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(currentTime)}
        onClick={handleScrub}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight") seek(currentTime + 1);
          if (event.key === "ArrowLeft") seek(currentTime - 1);
        }}
        className="relative flex h-full flex-1 cursor-pointer items-end"
      >
        {loopStyle !== null ? (
          <div
            style={loopStyle}
            className="pointer-events-none absolute inset-y-0 border-x border-control bg-surface-2 opacity-50"
          />
        ) : null}
        <div
          className="grid h-full w-full"
          style={{ gridTemplateColumns: `repeat(${barCount}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: barCount }, (_, idx) => {
            const isMajorBar = idx % 4 === 0;
            return (
              <div
                key={idx}
                className={`relative flex h-full items-start pl-1 pt-1 ${
                  idx > 0
                    ? isMajorBar
                      ? "border-l border-line-2"
                      : "border-l border-line/30"
                    : ""
                }`}
              >
                <span
                  className={`mono-num text-[10px] ${
                    isMajorBar ? "font-semibold text-text" : "text-muted/70"
                  }`}
                >
                  {idx + 1}
                </span>
              </div>
            );
          })}
        </div>
        <div
          style={{ left: `${playPercent}%` }}
          className="pointer-events-none absolute top-0 bottom-0 z-10 w-[1.5px] bg-accent shadow-xs"
        />
      </div>
      {rightSlot !== undefined ? (
        <div className="hidden shrink-0 items-center border-l border-line px-3 sm:flex">
          {rightSlot}
        </div>
      ) : null}
    </div>
  );
}

/** Quiet DAW shell for `/` (Project Hub / Ingest). */
export function AddShell({ center, inspector }: AddShellProps) {
  const nav: NavState = { current: "add" };

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text lg:h-dvh lg:overflow-hidden">
      <AppHeader nav={nav} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
        <main className="flex min-w-0 flex-1 flex-col items-center justify-start bg-bg p-4 md:p-8 lg:overflow-y-auto">
          <div className="w-full max-w-2xl mx-auto">
            {center}
          </div>
        </main>

        <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-line bg-surface p-5 lg:w-96 lg:border-t-0 lg:border-l lg:overflow-y-auto">
          {inspector}
        </aside>
      </div>
    </div>
  );
}

/** Persistent Quiet DAW shell for `/c/[id]/*` with fixed bottom transport and Project Tracks panel. */
export function StudioShell({ children }: StudioShellProps) {
  const pathname = usePathname();
  const {
    clipId,
    trackMap,
    selectedIsolationId,
    selectIsolation,
    monitor,
    setMonitor,
    playing,
    togglePlay,
    currentTime,
    duration,
    seek,
    ratePercent,
    setRatePercent,
    loopBars,
    setLoopBars,
  } = useStudio();

  const step = detectStepFromPath(pathname);
  const nav: NavState = {
    current: step,
    clipId,
    soundPicked: trackMap.isolations.length > 0,
    isolationId: selectedIsolationId,
  };
  const barBeat = formatBarBeat(
    currentTime,
    trackMap.downbeats,
    trackMap.tempo.time_signature,
    duration,
  );

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text lg:h-dvh lg:overflow-hidden">
      <AppHeader nav={nav} />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
        {/* Project & Audio Tracks (Stems) Sidebar */}
        <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-line bg-surface/70 backdrop-blur-xs lg:flex">
          <div className="space-y-4 p-3 overflow-y-auto">
            {/* Project Card */}
            <div className="rounded-card border border-line-2 bg-inset p-3 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] text-muted font-semibold tracking-wider uppercase">
                <span>Project</span>
                <span className="mono-num font-mono text-[10px] text-accent">Active</span>
              </div>
              <p className="truncate text-xs font-semibold text-text" title={trackMap.source.title}>
                {trackMap.source.title}
              </p>
              <div className="flex flex-wrap items-center gap-1 pt-0.5 text-[10px] text-text-2">
                <span className="mono-num rounded-icon border border-line-2 bg-surface px-1.5 py-0.5">
                  {Math.round(trackMap.tempo.bpm)} BPM
                </span>
                <span className="mono-num rounded-icon border border-line-2 bg-surface px-1.5 py-0.5">
                  {trackMap.key.tonic} {trackMap.key.mode}
                </span>
                <span className="mono-num rounded-icon border border-line-2 bg-surface px-1.5 py-0.5">
                  {Math.round(duration)}s
                </span>
              </div>
            </div>

            {/* Audio Tracks / Stems Section */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="text-[11px] font-semibold tracking-wider text-muted uppercase">Audio Tracks</span>
                <span className="mono-num text-[10px] text-muted">Stems</span>
              </div>

              {/* Master / Full Mix stem */}
              <button
                type="button"
                aria-pressed={monitor === "mix"}
                onClick={() => setMonitor("mix")}
                className={`flex w-full cursor-pointer items-center justify-between rounded-card border px-2.5 py-2 text-left text-xs transition ${
                  monitor === "mix"
                    ? "border-control bg-surface-2 font-medium text-text shadow-xs"
                    : "border-transparent text-text-2 hover:bg-surface-2/60 hover:text-text"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      monitor === "mix" ? "bg-accent shadow-xs shadow-accent/40" : "bg-inactive"
                    }`}
                  />
                  <span className="truncate">Full Mix (Master)</span>
                </div>
                <span className="mono-num ml-1 shrink-0 rounded-xs bg-bg/60 px-1.5 py-0.5 text-[10px] uppercase text-muted">
                  Mix [3]
                </span>
              </button>

              {/* Isolated Sound stem(s) */}
              {trackMap.isolations.length > 0 ? (
                trackMap.isolations.map((iso) => {
                  const isSelected = iso.id === selectedIsolationId;
                  const isMonitored = monitor === "sound" && isSelected;
                  return (
                    <button
                      key={iso.id}
                      type="button"
                      aria-pressed={isMonitored}
                      onClick={() => {
                        selectIsolation(iso.id);
                        setMonitor("sound");
                      }}
                      className={`flex w-full cursor-pointer items-center justify-between rounded-card border px-2.5 py-2 text-left text-xs transition ${
                        isMonitored
                          ? "border-control bg-surface-2 font-medium text-text shadow-xs"
                          : "border-transparent text-text-2 hover:bg-surface-2/60 hover:text-text"
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={`h-2 w-2 shrink-0 rounded-full ${
                            isMonitored ? "bg-accent shadow-xs shadow-accent/40" : "bg-inactive"
                          }`}
                        />
                        <span className="truncate">{iso.label}</span>
                      </div>
                      <span className="mono-num ml-1 shrink-0 rounded-xs bg-bg/60 px-1.5 py-0.5 text-[10px] uppercase text-muted">
                        {iso.method === "demucs" ? "DEM [1]" : "SAM [1]"}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="rounded-card border border-dashed border-line-2 p-2.5 text-center text-xs text-muted">
                  No isolated sound yet
                </div>
              )}

              {/* Rest / Backing stem */}
              <button
                type="button"
                aria-pressed={monitor === "rest"}
                onClick={() => setMonitor("rest")}
                className={`flex w-full cursor-pointer items-center justify-between rounded-card border px-2.5 py-2 text-left text-xs transition ${
                  monitor === "rest"
                    ? "border-control bg-surface-2 font-medium text-text shadow-xs"
                    : "border-transparent text-text-2 hover:bg-surface-2/60 hover:text-text"
                }`}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      monitor === "rest" ? "bg-accent shadow-xs shadow-accent/40" : "bg-inactive"
                    }`}
                  />
                  <span className="truncate">Rest (Backing)</span>
                </div>
                <span className="mono-num ml-1 shrink-0 rounded-xs bg-bg/60 px-1.5 py-0.5 text-[10px] uppercase text-muted">
                  Rest [2]
                </span>
              </button>
            </div>
          </div>

          {/* Quick Shortcuts & Return to Projects */}
          <div className="space-y-3 border-t border-line p-3 text-xs text-muted">
            <div className="space-y-1.5">
              <span className="text-[10px] font-semibold tracking-wider uppercase text-muted/70 block mb-1">
                Shortcuts
              </span>
              <div className="flex items-center justify-between">
                <span>Play / Pause</span>
                <span className="mono-num rounded-xs bg-surface-2 px-1.5 py-0.5 text-xs text-text-2">Space</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Solo Tracks</span>
                <span className="mono-num rounded-xs bg-surface-2 px-1.5 py-0.5 text-xs text-text-2">1 · 2 · 3</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Virtual Keys</span>
                <span className="mono-num rounded-xs bg-surface-2 px-1.5 py-0.5 text-xs text-text-2">A – L</span>
              </div>
            </div>

            <Link
              href="/"
              className="flex w-full items-center justify-center gap-1.5 rounded-card border border-line-2 bg-surface-2/40 px-3 py-2 text-xs font-medium text-text-2 transition hover:border-control hover:bg-surface-2 hover:text-text"
              title="Return to projects hub"
            >
              <span>← All Projects</span>
            </Link>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
          {children}
        </div>
      </div>

      <footer className="flex min-h-15 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-surface/90 px-4 py-2.5 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
          <Link
            href="/"
            className="flex h-9 items-center gap-1 rounded-full border border-line-2 bg-surface-2/60 px-3 text-xs font-medium text-text-2 transition hover:border-control hover:text-text lg:hidden"
            title="Return to projects hub"
          >
            <span>← Projects</span>
          </Link>
          <button
            type="button"
            aria-label="Return to start"
            onClick={() =>
              seek(loopBars !== null ? (trackMap.downbeats[loopBars.startBar - 1] ?? 0) : 0)
            }
            className="mono-num flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-line-2 bg-surface-2/60 text-xs text-text-2 transition hover:border-control hover:text-text"
          >
            |&lt;
          </button>
          <button
            type="button"
            aria-pressed={playing}
            onClick={togglePlay}
            className="flex h-9 cursor-pointer items-center gap-2 rounded-full bg-text px-4.5 text-sm font-semibold text-bg shadow-sm transition hover:opacity-90 active:scale-[0.98]"
          >
            <span>{playing ? "Pause" : "Play"}</span>
            <span className="mono-num text-xs opacity-70">[Space]</span>
          </button>
          <div className="mono-num ml-1 flex items-center gap-2 rounded-full border border-line-2 bg-surface-2/50 px-4 py-2 text-xs sm:text-sm text-text">
            <span className="font-semibold">{barBeat}</span>
            <span className="text-line-2">|</span>
            <span className="text-text-2">{formatClockSeconds(currentTime)}</span>
            <span className="text-muted">/ {formatClockSeconds(duration)}</span>
          </div>
        </div>

        <div
          role="group"
          aria-label="Monitor stem switch"
          className="flex items-center rounded-full border border-line-2 bg-surface-2/70 p-1 text-xs sm:text-sm shadow-xs"
        >
          {MONITOR_OPTIONS.map((opt) => {
            const active = monitor === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={active}
                onClick={() => setMonitor(opt.id)}
                className={`cursor-pointer rounded-full px-4 py-1 text-xs sm:text-sm font-medium transition ${
                  active
                    ? "bg-text font-semibold text-bg shadow-xs"
                    : "text-text-2 hover:text-text"
                }`}
              >
                {opt.label} <span className="mono-num opacity-60 text-xs">{opt.keyHint}</span>
              </button>
            );
          })}
        </div>

        <div className="hidden items-center gap-3.5 md:flex">
          <label className="flex items-center gap-2 text-xs text-text-2">
            <span>Rate</span>
            <input
              type="range"
              min={40}
              max={100}
              step={5}
              value={ratePercent}
              onChange={(event) => setRatePercent(Number(event.target.value))}
              className="w-20 cursor-pointer accent-accent"
            />
            <span className="mono-num w-9 text-right text-text">{ratePercent}%</span>
          </label>
          <button
            type="button"
            aria-pressed={loopBars !== null}
            onClick={() =>
              setLoopBars(
                loopBars !== null
                  ? null
                  : {
                      startBar: Math.min(5, trackMap.downbeats.length || 1),
                      endBar: Math.min(8, trackMap.downbeats.length || 4),
                    },
              )
            }
            className={`mono-num h-8 cursor-pointer rounded-full border px-3 text-xs transition ${
              loopBars !== null
                ? "border-accent bg-accent/15 font-medium text-accent"
                : "border-line-2 bg-surface-2/60 text-text-2 hover:border-control hover:text-text"
            }`}
          >
            {loopBars !== null ? `Loop: Bars ${loopBars.startBar}–${loopBars.endBar}` : "Loop: Off"}
          </button>
        </div>
      </footer>
    </div>
  );
}

