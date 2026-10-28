"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import { drawEnergyCurve, drawMiniRoll } from "@/lib/studio/canvas";
import { firstSoundingBar, formatPitchRange } from "@/lib/studio/format";
import { RecipeCard } from "./RecipeCard";
import { useStudio } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";

export function XRayView() {
  const { clipId, trackMap, selectedIsolation, selectedIsolationId, currentTime, duration, seek } =
    useStudio();

  const notesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const energyCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const notes = useMemo(() => selectedIsolation?.notes ?? [], [selectedIsolation]);

  useEffect(() => {
    if (notesCanvasRef.current !== null) {
      drawMiniRoll({
        canvas: notesCanvasRef.current,
        notes,
        currentTime,
        duration,
        downbeats: trackMap.downbeats,
      });
    }
    if (energyCanvasRef.current !== null) {
      drawEnergyCurve({
        canvas: energyCanvasRef.current,
        values: trackMap.energy.values,
        currentTime,
        duration,
        downbeats: trackMap.downbeats,
      });
    }
  }, [notes, currentTime, duration, trackMap.downbeats, trackMap.energy.values]);

  const scrubCanvas = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seek(ratio * duration);
  };

  const rangeText = formatPitchRange(selectedIsolation?.range, notes);
  const entersText = firstSoundingBar(notes, trackMap.downbeats);
  const summaryText =
    selectedIsolation?.summary ??
    trackMap.summary ??
    "Transcribed notes, chord progression and energy profile aligned to the bar grid.";

  const learnHref =
    selectedIsolationId.length > 0
      ? `/c/${encodeURIComponent(clipId)}/learn?iso=${encodeURIComponent(selectedIsolationId)}`
      : `/c/${encodeURIComponent(clipId)}/learn`;

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-bg lg:overflow-y-auto">
        <TimelineRuler />

        <div className="grid grid-cols-2 divide-x divide-y divide-line border-b border-line bg-surface sm:grid-cols-4 sm:divide-y-0">
          <div className="px-4 py-2">
            <span className="eyebrow block">Tempo</span>
            <span className="mono-num text-xs font-semibold text-text">
              {Math.round(trackMap.tempo.bpm)} BPM
            </span>
          </div>
          <div className="px-4 py-2">
            <span className="eyebrow block">Key</span>
            <span className="mono-num text-xs font-semibold text-text">
              {trackMap.key.tonic} {trackMap.key.mode}
            </span>
          </div>
          <div className="px-4 py-2">
            <span className="eyebrow block">Range</span>
            <span className="mono-num text-xs font-semibold text-text">{rangeText}</span>
          </div>
          <div className="px-4 py-2">
            <span className="eyebrow block">Enters</span>
            <span className="mono-num text-xs font-semibold text-text">{entersText}</span>
          </div>
        </div>

        <div className="flex h-10 items-stretch border-b border-line">
          <div className="mono-num flex w-28 shrink-0 items-center border-r border-line bg-surface px-3 text-xs text-muted sm:w-36">
            Sections
          </div>
          <div className="relative flex flex-1 divide-x divide-line bg-inset">
            {trackMap.sections.length > 0 ? (
              trackMap.sections.map((section, idx) => {
                const widthPct =
                  duration > 0 ? Math.max(4, ((section.end - section.start) / duration) * 100) : 50;
                const isPeak = section.label === "drop" || section.label === "chorus";
                return (
                  <button
                    key={`${section.label}-${idx}`}
                    type="button"
                    onClick={() => seek(section.start)}
                    style={{ width: `${widthPct}%` }}
                    className={`mono-num flex cursor-pointer items-center px-3 text-left text-xs uppercase transition ${
                      isPeak
                        ? "bg-surface-2 font-medium text-text"
                        : "text-text-2 hover:bg-surface hover:text-text"
                    }`}
                  >
                    {section.label}
                  </button>
                );
              })
            ) : (
              <div className="mono-num flex items-center px-3 text-xs text-muted">Full clip</div>
            )}
          </div>
        </div>

        <div className="flex h-10 items-stretch border-b border-line">
          <div className="mono-num flex w-28 shrink-0 items-center border-r border-line bg-surface px-3 text-xs text-muted sm:w-36">
            Chords
          </div>
          <div
            className="mono-num grid flex-1 divide-x divide-line bg-inset text-xs"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, trackMap.chords.length)}, minmax(0, 1fr))`,
            }}
          >
            {trackMap.chords.map((chord) => {
              const active = currentTime >= chord.start && currentTime < chord.end;
              return (
                <button
                  key={chord.bar}
                  type="button"
                  onClick={() => seek(chord.start)}
                  className={`flex cursor-pointer items-center justify-center transition ${
                    active
                      ? "bg-surface-2 font-semibold text-accent"
                      : "text-text hover:bg-surface"
                  }`}
                >
                  {chord.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex h-36 items-stretch border-b border-line">
          <div className="flex w-28 shrink-0 flex-col justify-between border-r border-line bg-surface p-3 sm:w-36">
            <span className="mono-num text-xs text-muted">Notes</span>
            <span className="mono-num text-[11px] text-text-2">{notes.length} notes</span>
          </div>
          <div onClick={scrubCanvas} className="relative flex-1 cursor-pointer bg-inset">
            <canvas
              ref={notesCanvasRef}
              width={960}
              height={144}
              role="img"
              aria-label={`Piano roll of ${selectedIsolation?.label ?? "picked sound"} (${notes.length} notes, range ${rangeText})`}
              className="block h-full w-full"
            />
          </div>
        </div>

        <div className="flex h-20 items-stretch border-b border-line">
          <div className="mono-num flex w-28 shrink-0 items-center border-r border-line bg-surface px-3 text-xs text-muted sm:w-36">
            Energy
          </div>
          <div onClick={scrubCanvas} className="relative flex-1 cursor-pointer bg-inset">
            <canvas
              ref={energyCanvasRef}
              width={960}
              height={80}
              role="img"
              aria-label="Clip energy curve across bars"
              className="block h-full w-full"
            />
          </div>
        </div>
      </section>

      <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-line bg-surface p-4 lg:w-80 lg:border-t-0 lg:border-l lg:overflow-y-auto">
        <div>
          <span className="eyebrow mb-1.5 block">Summary</span>
          <p className="rounded-well border border-line bg-inset p-3 text-xs leading-relaxed text-text">
            {summaryText}
          </p>
        </div>

        <div className="border-t border-line pt-3">
          <RecipeCard recipe={selectedIsolation?.recipe} />
        </div>

        <div className="mt-auto border-t border-line pt-3">
          <Link
            href={learnHref}
            className="flex h-8 w-full items-center justify-center rounded-icon bg-text text-xs font-semibold text-bg transition hover:opacity-90"
          >
            Learn on keyboard →
          </Link>
        </div>
      </aside>
    </>
  );
}
