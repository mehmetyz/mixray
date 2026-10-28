"use client";

import { usePathname } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import type { StemName } from "@/lib/audio/player";
import type { ClipStepId, NavState } from "@/lib/steps";
import { formatBarBeat, formatClockSeconds } from "@/lib/studio/format";
import { AppHeader } from "./AppHeader";
import { StepNav } from "./StepNav";
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
    <div className="flex h-9 shrink-0 select-none items-center border-b border-line bg-surface">
      <div className="mono-num flex w-28 shrink-0 items-center justify-between border-r border-line px-3 text-xs text-muted sm:w-36">
        <span>BARS</span>
        <span className="text-text">{formatClockSeconds(currentTime)}</span>
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
            className="pointer-events-none absolute inset-y-0 border-x border-control bg-surface-2 opacity-60"
          />
        ) : null}
        <div
          className="grid h-full w-full divide-x divide-line"
          style={{ gridTemplateColumns: `repeat(${barCount}, minmax(0, 1fr))` }}
        >
          {Array.from({ length: barCount }, (_, idx) => (
            <span key={idx} className="mono-num pl-1 pt-1 text-[10px] text-muted">
              {idx + 1}
            </span>
          ))}
        </div>
        <div
          style={{ left: `${playPercent}%` }}
          className="pointer-events-none absolute top-0 bottom-0 z-10 w-[1.5px] bg-accent"
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

/** Quiet DAW shell for `/` (Step 1 · Add). */
export function AddShell({ center, inspector }: AddShellProps) {
  const nav: NavState = { current: "add" };

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text lg:h-dvh lg:overflow-hidden">
      <AppHeader nav={nav} />
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
        <aside className="hidden w-52 shrink-0 flex-col justify-between border-r border-line bg-surface p-3 lg:flex">
          <div>
            <StepNav nav={nav} variant="sidebar" />
          </div>
          <div className="border-t border-line px-2 pt-3 text-[11px] text-muted">
            <span className="mono-num">≤ 30s · SHA-256 cached</span>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col bg-bg p-5 md:p-8 lg:overflow-y-auto">
          {center}
        </main>

        <aside className="flex w-full shrink-0 flex-col gap-5 border-t border-line bg-surface p-4 lg:w-80 lg:border-t-0 lg:border-l lg:overflow-y-auto">
          {inspector}
        </aside>
      </div>
    </div>
  );
}

/** Persistent Quiet DAW shell for `/c/[id]/*` (Steps 2–5) with fixed bottom transport. */
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
  const clipMeta = `${trackMap.source.title} · ${Math.round(trackMap.tempo.bpm)} BPM · ${trackMap.key.tonic} ${trackMap.key.mode}`;
  const barBeat = formatBarBeat(
    currentTime,
    trackMap.downbeats,
    trackMap.tempo.time_signature,
    duration,
  );

  return (
    <div className="flex min-h-dvh flex-col bg-bg text-text lg:h-dvh lg:overflow-hidden">
      <AppHeader nav={nav} clipMeta={clipMeta} />

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
        <aside className="hidden w-52 shrink-0 flex-col justify-between border-r border-line bg-surface lg:flex">
          <div className="space-y-4 p-3">
            <div>
              <StepNav nav={nav} variant="sidebar" />
            </div>

            {trackMap.isolations.length > 0 ? (
              <div>
                <p className="eyebrow mb-1.5 px-2">Sounds</p>
                <div className="space-y-1">
                  {trackMap.isolations.map((iso) => {
                    const active = iso.id === selectedIsolationId;
                    return (
                      <button
                        key={iso.id}
                        type="button"
                        aria-pressed={active}
                        onClick={() => selectIsolation(iso.id)}
                        className={`flex w-full cursor-pointer items-center justify-between rounded-icon border px-2 py-1.5 text-left text-xs transition ${
                          active
                            ? "border-line-2 bg-surface-2 font-medium text-text"
                            : "border-transparent text-text-2 hover:bg-surface-2 hover:text-text"
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              active ? "bg-accent" : "bg-inactive"
                            }`}
                          />
                          <span className="truncate">{iso.label}</span>
                        </span>
                        <span className="mono-num ml-1 shrink-0 text-[10px] uppercase text-muted">
                          {iso.method === "demucs" ? "DEM" : "SAM"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-1 border-t border-line p-3 text-[11px] text-muted">
            <div className="flex items-center justify-between">
              <span>Play/Pause</span>
              <span className="mono-num text-text-2">Space</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Sound/Rest/Mix</span>
              <span className="mono-num text-text-2">1·2·3</span>
            </div>
            <div className="flex items-center justify-between">
              <span>Piano</span>
              <span className="mono-num text-text-2">A–L</span>
            </div>
          </div>
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row lg:overflow-hidden">
          {children}
        </div>
      </div>

      <footer className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-3 border-t border-line bg-surface px-4 py-2">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-label="Return to start"
            onClick={() =>
              seek(loopBars !== null ? (trackMap.downbeats[loopBars.startBar - 1] ?? 0) : 0)
            }
            className="mono-num flex h-8 w-8 cursor-pointer items-center justify-center rounded-icon border border-line-2 bg-bg text-xs text-text-2 hover:border-control hover:text-text"
          >
            |&lt;
          </button>
          <button
            type="button"
            aria-pressed={playing}
            onClick={togglePlay}
            className="flex h-8 cursor-pointer items-center gap-2 rounded-icon bg-text px-4 text-xs font-semibold text-bg transition hover:opacity-90"
          >
            <span>{playing ? "Pause" : "Play"}</span>
            <span className="mono-num text-[10px] opacity-70">[Space]</span>
          </button>
          <div className="mono-num ml-1 flex items-center gap-2 rounded-icon border border-line bg-inset px-3 py-1.5 text-xs">
            <span className="font-semibold text-text">{barBeat}</span>
            <span className="text-line-2">|</span>
            <span className="text-text-2">{formatClockSeconds(currentTime)}</span>
            <span className="text-muted">/ {formatClockSeconds(duration)}</span>
          </div>
        </div>

        <div
          role="group"
          aria-label="Monitor stem switch"
          className="flex items-center rounded-icon border border-line-2 bg-inset p-0.5 text-xs"
        >
          {MONITOR_OPTIONS.map((opt) => {
            const active = monitor === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                aria-pressed={active}
                onClick={() => setMonitor(opt.id)}
                className={`cursor-pointer rounded-icon px-3 py-1 font-medium transition ${
                  active ? "bg-text text-bg" : "text-text-2 hover:text-text"
                }`}
              >
                {opt.label} <span className="mono-num opacity-60">{opt.keyHint}</span>
              </button>
            );
          })}
        </div>

        <div className="hidden items-center gap-4 md:flex">
          <label className="flex items-center gap-2 text-xs text-text-2">
            <span>Rate</span>
            <input
              type="range"
              min={40}
              max={100}
              step={5}
              value={ratePercent}
              onChange={(event) => setRatePercent(Number(event.target.value))}
              className="w-20 cursor-pointer"
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
            className={`mono-num h-8 cursor-pointer rounded-icon border px-3 text-xs transition ${
              loopBars !== null
                ? "border-text bg-surface-2 text-text"
                : "border-line-2 bg-bg text-text-2 hover:border-control hover:text-text"
            }`}
          >
            {loopBars !== null ? `Loop: Bars ${loopBars.startBar}–${loopBars.endBar}` : "Loop: Off"}
          </button>
        </div>
      </footer>
    </div>
  );
}

