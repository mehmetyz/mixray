"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import type { StemName } from "@/lib/audio/player";
import type { ClipStepId, NavState } from "@/lib/steps";
import type { Isolation } from "@/lib/trackmap/trackmap.generated";
import { barAtTime, formatBarBeat, formatClockSeconds, methodShortLabel } from "@/lib/studio/format";
import { findDemoClip } from "@/lib/demos";
import { useProject } from "@/lib/projects/storage";
import { AppHeader } from "./AppHeader";
import { DemoBadge, DemoCredit } from "./DemoBadge";
import { useStudio, type BarLoop } from "./StudioContext";

type TimelineRulerProps = {
  rightSlot?: ReactNode;
};

type AddShellProps = {
  children: ReactNode;
  className?: string;
};

type StudioShellProps = {
  children: ReactNode;
};

type MonitorOption = {
  id: StemName;
  label: string;
};

const MONITOR_OPTIONS: readonly MonitorOption[] = [
  { id: "sound", label: "Sound" },
  { id: "rest", label: "Rest" },
  { id: "mix", label: "Full mix" },
];

const LOOP_LENGTH_BARS = 4;

/** Loops the four bars starting where the player is, which is what a player reaches for. */
function loopFromCurrentBar(time: number, downbeats: number[]): BarLoop {
  const startBar = barAtTime(time, downbeats);
  return {
    startBar,
    endBar: Math.max(startBar, Math.min(startBar + LOOP_LENGTH_BARS - 1, downbeats.length)),
  };
}

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

/** Quiet shell for `/` (Dashboard / Add). */
export function AddShell({ children, className = "max-w-6xl" }: AddShellProps) {
  const nav: NavState = { current: "add" };

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text">
      <AppHeader nav={nav} />
      <main className={`mx-auto w-full flex-1 p-4 pt-6 md:pt-10 ${className}`}>{children}</main>
    </div>
  );
}

/** Persistent Quiet DAW shell for `/c/[id]/*` with fixed bottom transport and Project Tracks panel. */
type SoundButtonProps = {
  isolation: Isolation;
  isSelected: boolean;
  onSelect: () => void;
  variant: "row" | "chip";
};

function SoundButton({ isolation, isSelected, onSelect, variant }: SoundButtonProps) {
  const look =
    variant === "row"
      ? `flex w-full items-center justify-between rounded-card border px-2.5 py-2 text-left text-sm ${
          isSelected
            ? "border-control bg-surface-2 font-medium text-text"
            : "border-transparent text-text-2 hover:bg-surface-2/60 hover:text-text"
        }`
      : `flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
          isSelected
            ? "border-control bg-surface-2 font-medium text-text"
            : "border-line-2 text-text-2 hover:text-text"
        }`;
  return (
    <button type="button" aria-pressed={isSelected} onClick={onSelect} className={`cursor-pointer transition ${look}`}>
      <span className="flex min-w-0 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${isSelected ? "bg-accent" : "bg-inactive"}`} />
        <span className="truncate">{isolation.label}</span>
      </span>
      <span className={`shrink-0 text-muted ${variant === "row" ? "ml-2 text-xs" : "text-[11px]"}`}>
        {methodShortLabel(isolation.method)}
      </span>
    </button>
  );
}

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
  const demo = findDemoClip(useProject(clipId)?.demoId);
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

      {/* Narrower screens: the clip and its sounds on one scrolling strip instead of a sidebar. */}
      <div className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-line bg-surface/70 px-4 py-2.5 xl:hidden">
        <div className="min-w-0 shrink-0">
          <p className="max-w-48 truncate text-sm font-semibold text-text">{trackMap.source.title}</p>
          <p className="mono-num text-[11px] text-muted">
            {Math.round(trackMap.tempo.bpm)} BPM, {trackMap.key.tonic} {trackMap.key.mode}
          </p>
        </div>
        {demo !== undefined ? <DemoBadge origin={demo.origin} /> : null}
        <div className="flex items-center gap-1.5 border-l border-line pl-3">
          {trackMap.isolations.length > 0 ? (
            trackMap.isolations.map((iso) => (
              <SoundButton
                key={iso.id}
                isolation={iso}
                isSelected={iso.id === selectedIsolationId}
                onSelect={() => {
                  selectIsolation(iso.id);
                  setMonitor("sound");
                }}
                variant="chip"
              />
            ))
          ) : (
            <span className="whitespace-nowrap text-xs text-muted">No sound picked yet.</span>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
        {/* Project & Audio Tracks (Stems) Sidebar */}
        <aside className="hidden w-60 shrink-0 flex-col justify-between border-r border-line bg-surface/70 backdrop-blur-xs xl:flex">
          <div className="space-y-5 overflow-y-auto p-3">
            <div className="px-1 pt-1">
              <p className="truncate text-sm font-semibold text-text" title={trackMap.source.title}>
                {trackMap.source.title}
              </p>
              <p className="mono-num mt-1 text-xs text-muted">
                {Math.round(trackMap.tempo.bpm)} BPM, {trackMap.key.tonic} {trackMap.key.mode}
              </p>
              {demo !== undefined ? <DemoCredit demo={demo} /> : null}
            </div>

            <div className="space-y-1">
              <p className="px-1 pb-1 text-xs font-medium text-muted">Sounds</p>
              {trackMap.isolations.length > 0 ? (
                trackMap.isolations.map((iso) => (
                  <SoundButton
                    key={iso.id}
                    isolation={iso}
                    isSelected={iso.id === selectedIsolationId}
                    onSelect={() => {
                      selectIsolation(iso.id);
                      setMonitor("sound");
                    }}
                    variant="row"
                  />
                ))
              ) : (
                <p className="px-1 text-sm text-muted">No sound picked yet.</p>
              )}
            </div>
          </div>

          <div className="border-t border-line p-3">
            <Link
              href="/studio/new"
              className="flex h-9 w-full items-center justify-center rounded-card border border-line-2 text-sm text-text-2 transition hover:border-control hover:text-text"
            >
              New clip
            </Link>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
          {children}
        </div>
      </div>

      <footer className="flex min-h-15 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-surface/90 px-4 py-2.5 backdrop-blur-md">
        <div className="flex items-center gap-2.5">
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
            {playing ? "Pause" : "Play"}
          </button>
          <div className="mono-num ml-1 flex items-center gap-2 rounded-full border border-line-2 bg-surface-2/50 px-4 py-2 text-xs sm:text-sm text-text">
            <span className="font-semibold">{barBeat}</span>
            <span className="text-muted">{formatClockSeconds(duration)}</span>
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
                disabled={trackMap.isolations.length === 0 && opt.id !== "mix"}
                onClick={() => setMonitor(opt.id)}
                className={`cursor-pointer rounded-full px-4 py-1 text-xs sm:text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${
                  active
                    ? "bg-text font-semibold text-bg shadow-xs"
                    : "text-text-2 hover:text-text"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3.5">
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
                  : loopFromCurrentBar(currentTime, trackMap.downbeats),
              )
            }
            className={`mono-num h-8 cursor-pointer rounded-full border px-3 text-xs transition ${
              loopBars !== null
                ? "border-accent bg-accent/15 font-medium text-accent"
                : "border-line-2 bg-surface-2/60 text-text-2 hover:border-control hover:text-text"
            }`}
          >
            {loopBars !== null ? `Loop bars ${loopBars.startBar}–${loopBars.endBar}` : "Loop"}
          </button>
        </div>
      </footer>
    </div>
  );
}

