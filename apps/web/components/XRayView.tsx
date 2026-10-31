"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { drawEnergyCurve, drawMiniRoll } from "@/lib/studio/canvas";
import { firstSoundingBar, formatPitchRange } from "@/lib/studio/format";
import { RecipeCard } from "./RecipeCard";
import { useStudio } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";
import { useThemeListener } from "./ThemeToggle";

const CAMELOT_KEYS: Record<string, string> = {
  "A minor": "8A",
  "E minor": "9A",
  "B minor": "10A",
  "F# minor": "11A",
  "C# minor": "12A",
  "G# minor": "1A",
  "D# minor": "2A",
  "Bb minor": "3A",
  "F minor": "4A",
  "C minor": "5A",
  "G minor": "6A",
  "D minor": "7A",
  "C major": "8B",
  "G major": "9B",
  "D major": "10B",
  "A major": "11B",
  "E major": "12B",
  "B major": "1B",
  "F# major": "2B",
  "Db major": "3B",
  "Ab major": "4B",
  "Eb major": "5B",
  "Bb major": "6B",
  "F major": "7B",
};

function getRomanNumeral(keyTonic: string, keyMode: string, chordLabel: string): string {
  const roots = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const tIndex = roots.indexOf(keyTonic.toUpperCase());
  if (tIndex === -1) return "";
  const cTonic = chordLabel.replace(/m|maj|dim|aug|7|sus\d?/, "");
  const cIndex = roots.indexOf(cTonic.toUpperCase());
  if (cIndex === -1) return "";
  const interval = (cIndex - tIndex + 12) % 12;

  if (keyMode.toLowerCase() === "minor") {
    switch (interval) {
      case 0:
        return "i";
      case 2:
        return "ii°";
      case 3:
        return "III";
      case 5:
        return "iv";
      case 7:
        return "v";
      case 8:
        return "VI";
      case 10:
        return "VII";
      default:
        return "";
    }
  } else {
    switch (interval) {
      case 0:
        return "I";
      case 2:
        return "ii";
      case 4:
        return "iii";
      case 5:
        return "IV";
      case 7:
        return "V";
      case 9:
        return "vi";
      case 11:
        return "vii°";
      default:
        return "";
    }
  }
}

export function XRayView() {
  const { clipId, trackMap, selectedIsolation, selectedIsolationId, currentTime, duration, seek } =
    useStudio();
  const themeTick = useThemeListener();

  const notesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const energyCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const notesContainerRef = useRef<HTMLDivElement | null>(null);
  const energyContainerRef = useRef<HTMLDivElement | null>(null);

  const [notesSize, setNotesSize] = useState<{ width: number; height: number }>({ width: 960, height: 160 });
  const [energySize, setEnergySize] = useState<{ width: number; height: number }>({ width: 960, height: 90 });

  const notes = useMemo(() => selectedIsolation?.notes ?? [], [selectedIsolation]);

  // Handle responsive canvas resolutions cleanly without per-frame resets
  useEffect(() => {
    const elNotes = notesContainerRef.current;
    if (elNotes) {
      const updateNotes = () => {
        if (elNotes.clientWidth > 0 && elNotes.clientHeight > 0) {
          setNotesSize({ width: elNotes.clientWidth, height: elNotes.clientHeight });
        }
      };
      updateNotes();
      const obsNotes = new ResizeObserver(updateNotes);
      obsNotes.observe(elNotes);
      return () => obsNotes.disconnect();
    }
  }, []);

  useEffect(() => {
    const elEnergy = energyContainerRef.current;
    if (elEnergy) {
      const updateEnergy = () => {
        if (elEnergy.clientWidth > 0 && elEnergy.clientHeight > 0) {
          setEnergySize({ width: elEnergy.clientWidth, height: elEnergy.clientHeight });
        }
      };
      updateEnergy();
      const obsEnergy = new ResizeObserver(updateEnergy);
      obsEnergy.observe(elEnergy);
      return () => obsEnergy.disconnect();
    }
  }, []);

  // Frame draw loop: synchronizes backing resolution and immediately renders MiniRoll & EnergyCurve
  useEffect(() => {
    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;

    const notesCanvas = notesCanvasRef.current;
    if (notesCanvas !== null) {
      const targetW = Math.max(1, Math.round(notesSize.width * dpr));
      const targetH = Math.max(1, Math.round(notesSize.height * dpr));
      if (notesCanvas.width !== targetW || notesCanvas.height !== targetH) {
        notesCanvas.width = targetW;
        notesCanvas.height = targetH;
      }
      drawMiniRoll({
        canvas: notesCanvas,
        notes,
        currentTime,
        duration,
        downbeats: trackMap.downbeats,
        dpr,
      });
    }

    const energyCanvas = energyCanvasRef.current;
    if (energyCanvas !== null) {
      const targetW = Math.max(1, Math.round(energySize.width * dpr));
      const targetH = Math.max(1, Math.round(energySize.height * dpr));
      if (energyCanvas.width !== targetW || energyCanvas.height !== targetH) {
        energyCanvas.width = targetW;
        energyCanvas.height = targetH;
      }
      drawEnergyCurve({
        canvas: energyCanvas,
        values: trackMap.energy.values,
        currentTime,
        duration,
        downbeats: trackMap.downbeats,
        dpr,
      });
    }
  }, [
    notes,
    currentTime,
    duration,
    trackMap.downbeats,
    trackMap.energy.values,
    themeTick,
    notesSize,
    energySize,
  ]);

  const scrubCanvas = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seek(ratio * duration);
  };

  const rangeText = formatPitchRange(selectedIsolation?.range, notes);
  const entersText = firstSoundingBar(notes, trackMap.downbeats);
  const confidence = selectedIsolation?.pitch_confidence;
  const isApproximateReading = confidence !== undefined && confidence < 0.65;
  const confidencePct = confidence !== undefined ? Math.round(confidence * 100) : null;
  const keyLabel = `${trackMap.key.tonic} ${trackMap.key.mode}`;
  const camelotKey = CAMELOT_KEYS[keyLabel] ?? null;

  const summaryText =
    selectedIsolation?.summary ??
    trackMap.summary ??
    "Transcribed notes, chord progression, and energy profile aligned to the bar grid.";

  const learnHref =
    selectedIsolationId.length > 0
      ? `/c/${encodeURIComponent(clipId)}/learn?iso=${encodeURIComponent(selectedIsolationId)}`
      : `/c/${encodeURIComponent(clipId)}/learn`;

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-bg lg:overflow-y-auto">
        <TimelineRuler />

        {/* Hero Audio Intelligence KPI Grid */}
        <div className="grid grid-cols-2 divide-x divide-y divide-line border-b border-line bg-surface/90 sm:grid-cols-4 sm:divide-y-0">
          {/* Tempo Card */}
          <div className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="eyebrow block">Tempo</span>
              <span className="h-2 w-2 rounded-full bg-accent animate-pulse" />
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="mono-num text-xl font-bold tracking-tight text-text">
                {Math.round(trackMap.tempo.bpm)}
              </span>
              <span className="mono-num text-xs font-semibold text-muted">BPM</span>
            </div>
            <span className="mono-num block mt-0.5 text-[11px] text-text-2">
              {Math.round(trackMap.tempo.confidence * 100)}% beat stability
            </span>
          </div>

          {/* Key & Scale Card */}
          <div className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="eyebrow block">Harmonic Key</span>
              {camelotKey ? (
                <span className="mono-num rounded-xs border border-accent/30 bg-accent/10 px-1.5 py-0.2 text-[10px] font-mono text-accent">
                  {camelotKey}
                </span>
              ) : null}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="mono-num text-xl font-bold tracking-tight text-text">
                {trackMap.key.tonic}
              </span>
              <span className="text-sm font-semibold capitalize text-accent">
                {trackMap.key.mode}
              </span>
            </div>
            <span className="mono-num block mt-0.5 text-[11px] text-text-2">
              {Math.round(trackMap.key.confidence * 100)}% key certainty
            </span>
          </div>

          {/* Pitch Range Card */}
          <div className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="eyebrow block">Melodic Range</span>
              <span className="mono-num text-[10px] text-muted">{notes.length} notes</span>
            </div>
            <div className="mt-1">
              <span className="mono-num text-lg font-bold tracking-tight text-text truncate block">
                {rangeText}
              </span>
            </div>
            <span className="mono-num block mt-0.5 text-[11px] text-text-2">
              Easy arrangement register
            </span>
          </div>

          {/* Entrance & Timing Card */}
          <div className="p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <span className="eyebrow block">Enters At</span>
              <span className="mono-num text-[10px] text-muted">Bar index</span>
            </div>
            <div className="mt-1">
              <span className="mono-num text-lg font-bold tracking-tight text-text block">
                {entersText}
              </span>
            </div>
            <span className="mono-num block mt-0.5 text-[11px] text-text-2">
              {duration.toFixed(1)}s total duration
            </span>
          </div>
        </div>

        {/* Dynamic Section Map */}
        <div className="flex h-12 items-stretch border-b border-line">
          <div className="mono-num flex w-36 shrink-0 items-center justify-between border-r border-line bg-surface px-4 text-xs font-semibold text-muted sm:w-48">
            <span>SECTIONS</span>
            <span className="text-[10px] uppercase text-text-2 font-mono">
              {trackMap.sections.length} parts
            </span>
          </div>
          <div className="relative flex flex-1 divide-x divide-line bg-inset">
            {trackMap.sections.length > 0 ? (
              trackMap.sections.map((section, idx) => {
                const widthPct =
                  duration > 0 ? Math.max(5, ((section.end - section.start) / duration) * 100) : 50;
                const isPeak = section.label === "drop" || section.label === "chorus";
                const isBuild = section.label === "build";
                return (
                  <button
                    key={`${section.label}-${idx}`}
                    type="button"
                    onClick={() => seek(section.start)}
                    style={{ width: `${widthPct}%` }}
                    className={`mono-num flex cursor-pointer items-center justify-between px-3 text-left text-xs uppercase font-medium transition ${
                      isPeak
                        ? "bg-accent/15 text-accent font-semibold hover:bg-accent/25"
                        : isBuild
                          ? "bg-surface-2/80 text-text hover:bg-surface-2"
                          : "text-text-2 hover:bg-surface hover:text-text"
                    }`}
                  >
                    <span className="truncate">{section.label}</span>
                    <span className="text-[10px] opacity-60 font-mono hidden md:inline">
                      {Math.round(section.start)}s
                    </span>
                  </button>
                );
              })
            ) : (
              <div className="mono-num flex items-center px-4 text-xs text-muted">Full clip</div>
            )}
          </div>
        </div>

        {/* Chords Progression Harmonic Strip */}
        <div className="flex h-14 items-stretch border-b border-line">
          <div className="mono-num flex w-36 shrink-0 items-center justify-between border-r border-line bg-surface px-4 text-xs font-semibold text-muted sm:w-48">
            <span>CHORDS</span>
            <span className="text-[10px] font-mono text-accent">Harmonic</span>
          </div>
          <div
            className="mono-num grid flex-1 divide-x divide-line bg-inset text-xs"
            style={{
              gridTemplateColumns: `repeat(${Math.max(1, trackMap.chords.length)}, minmax(0, 1fr))`,
            }}
          >
            {trackMap.chords.map((chord) => {
              const active = currentTime >= chord.start && currentTime < chord.end;
              const numeral = getRomanNumeral(trackMap.key.tonic, trackMap.key.mode, chord.label);
              return (
                <button
                  key={chord.bar}
                  type="button"
                  onClick={() => seek(chord.start)}
                  className={`flex flex-col cursor-pointer items-center justify-center p-1 transition ${
                    active
                      ? "bg-accent text-accent-ink font-bold shadow-xs"
                      : "text-text hover:bg-surface-2/60"
                  }`}
                >
                  <span className="text-xs font-semibold leading-tight">{chord.label}</span>
                  {numeral ? (
                    <span
                      className={`text-[9px] font-mono leading-none ${
                        active ? "text-accent-ink opacity-90" : "text-muted"
                      }`}
                    >
                      {numeral}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* Interactive Piano Roll Lane */}
        <div className="flex h-44 items-stretch border-b border-line">
          <div className="flex w-36 shrink-0 flex-col justify-between border-r border-line bg-surface p-4 sm:w-48">
            <div>
              <div className="flex items-center justify-between">
                <span className="mono-num text-xs font-semibold text-text">Notes</span>
                <span className="mono-num text-[11px] font-medium text-accent">
                  {notes.length}
                </span>
              </div>
              {isApproximateReading ? (
                <span className="mt-1.5 inline-block rounded-xs border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
                  Approximate
                </span>
              ) : null}
            </div>

            <div className="space-y-1">
              {confidencePct !== null ? (
                <div className="space-y-0.5">
                  <div className="flex justify-between text-[10px] text-muted font-mono">
                    <span>Fidelity</span>
                    <span className="font-semibold text-text">{confidencePct}%</span>
                  </div>
                  <div className="h-1.5 w-full rounded-full bg-surface-2 overflow-hidden">
                    <div
                      style={{ width: `${confidencePct}%` }}
                      className={`h-full rounded-full ${
                        confidencePct > 80 ? "bg-accent" : "bg-amber-500"
                      }`}
                    />
                  </div>
                </div>
              ) : null}
              <span className="mono-num block text-[10px] text-muted">Basic Pitch extraction</span>
            </div>
          </div>

          <div
            ref={notesContainerRef}
            onClick={scrubCanvas}
            className="relative flex-1 cursor-pointer bg-inset overflow-hidden"
          >
            <canvas
              ref={notesCanvasRef}
              role="img"
              aria-label={`Piano roll of ${selectedIsolation?.label ?? "picked sound"} (${notes.length} notes, range ${rangeText})`}
              className="absolute inset-0 block h-full w-full"
            />
          </div>
        </div>

        {/* Clip Energy Curve Lane */}
        <div className="flex h-24 items-stretch border-b border-line">
          <div className="mono-num flex w-36 shrink-0 flex-col justify-between border-r border-line bg-surface p-4 sm:w-48">
            <span className="text-xs font-semibold text-text">Energy</span>
            <span className="text-[10px] text-muted">RMS dynamic curve</span>
          </div>
          <div
            ref={energyContainerRef}
            onClick={scrubCanvas}
            className="relative flex-1 cursor-pointer bg-inset overflow-hidden"
          >
            <canvas
              ref={energyCanvasRef}
              role="img"
              aria-label="Clip energy curve across bars"
              className="absolute inset-0 block h-full w-full"
            />
          </div>
        </div>
      </section>

      {/* Side Intelligence & Recipe Panel */}
      <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-line bg-surface p-5 lg:w-84 lg:border-t-0 lg:border-l lg:overflow-y-auto">
        {isApproximateReading ? (
          <div className="rounded-well border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs leading-relaxed text-amber-500">
            <strong className="block font-semibold">
              Approximate Reading ({confidencePct}% confidence)
            </strong>
            <span className="block mt-1 text-text-2 text-[11px] leading-normal">
              Complex or detuned timbre detected. The extracted notes provide a faithful harmonic
              approximation for learning on keyboard.
            </span>
          </div>
        ) : null}

        {/* Sound Summary Card */}
        <div>
          <span className="eyebrow mb-2 block">Audio Summary</span>
          <div className="rounded-card border border-line bg-inset p-3.5 text-xs leading-relaxed text-text">
            <p className="italic text-text-2">&quot;{summaryText}&quot;</p>
          </div>
        </div>

        {/* Synth Recipe Inspector */}
        <div className="border-t border-line pt-3">
          <RecipeCard recipe={selectedIsolation?.recipe} />
        </div>

        {/* Primary CTA Button */}
        <div className="mt-auto border-t border-line pt-4">
          <Link
            href={learnHref}
            className="flex h-10 w-full items-center justify-center rounded-icon bg-accent text-xs font-bold text-accent-ink shadow-sm transition hover:opacity-95"
          >
            Start Practice on Keys →
          </Link>
        </div>
      </aside>
    </>
  );
}
