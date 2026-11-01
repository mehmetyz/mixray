"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { followTrack, waitForTrackFrames } from "@/lib/engine/client";
import { drawMiniRoll } from "@/lib/studio/canvas";
import { firstSoundingBar, formatPitchRange } from "@/lib/studio/format";
import { RecipeCard } from "./RecipeCard";
import { useStudio } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";
import { useThemeListener } from "./ThemeToggle";
import { VideoMaskStage } from "./VideoMaskStage";

export function XRayView() {
  const router = useRouter();
  const {
    clipId,
    trackMap,
    selectedIsolation,
    selectedIsolationId,
    currentTime,
    duration,
    seek,
    notesPending,
  } = useStudio();
  const [trackingOn, setTrackingOn] = useState<boolean>(false);
  const [trackingBusy, setTrackingBusy] = useState<boolean>(false);
  const [trackingError, setTrackingError] = useState<string | null>(null);
  const selectedTrack = trackMap.video?.tracks.find(
    (track) => track.isolation_id === selectedIsolationId,
  );

  const toggleTracking = async () => {
    if (selectedTrack === undefined || trackingBusy) return;
    if (trackingOn || selectedTrack.visible.length > 0) {
      setTrackingOn(!trackingOn);
      return;
    }
    setTrackingError(null);
    setTrackingBusy(true);
    try {
      await followTrack(clipId, selectedTrack.id);
      await waitForTrackFrames(selectedTrack.masks_url);
      router.refresh();
      setTrackingOn(true);
    } catch (error: unknown) {
      setTrackingError(error instanceof Error ? error.message : "Could not track this area.");
    } finally {
      setTrackingBusy(false);
    }
  };
  const themeTick = useThemeListener();

  const notesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const notesContainerRef = useRef<HTMLDivElement | null>(null);

  const [notesSize, setNotesSize] = useState<{ width: number; height: number }>({ width: 960, height: 160 });

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

  }, [
    notes,
    currentTime,
    duration,
    trackMap.downbeats,
    themeTick,
    notesSize,
  ]);

  const scrubCanvas = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    seek(ratio * duration);
  };

  const rangeText = formatPitchRange(selectedIsolation?.range, notes);
  const entersText = firstSoundingBar(notes, trackMap.downbeats);
  const summaryText = selectedIsolation?.summary ?? trackMap.summary;

  const learnHref =
    selectedIsolationId.length > 0
      ? `/c/${encodeURIComponent(clipId)}/learn?iso=${encodeURIComponent(selectedIsolationId)}`
      : `/c/${encodeURIComponent(clipId)}/learn`;

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-bg lg:overflow-y-auto">
        <TimelineRuler />

        {trackMap.video !== undefined && selectedTrack !== undefined ? (
          <>
            {trackingOn ? (
              <VideoMaskStage
                video={trackMap.video}
                followedTrackId={selectedTrack.id}
                sizeClass="max-w-[calc(32dvh*16/9)]"
              />
            ) : null}
            <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2 text-sm">
              <span role={trackingError !== null ? "alert" : undefined} className="min-w-0 truncate text-muted">
                {trackingError ??
                  (trackingBusy
                    ? `Following ${selectedTrack.label} through the video…`
                    : `Follow ${selectedTrack.label} in the video`)}
              </span>
              <button
                type="button"
                aria-pressed={trackingOn}
                disabled={trackingBusy}
                onClick={() => void toggleTracking()}
                className={`shrink-0 cursor-pointer rounded-full border px-3 py-1 text-xs font-medium disabled:cursor-wait disabled:opacity-60 ${
                  trackingOn ? "border-accent text-accent" : "border-line-2 text-text-2 hover:text-text"
                }`}
              >
                {trackingBusy ? "Tracking…" : trackingOn ? "Track on" : "Track off"}
              </button>
            </div>
          </>
        ) : null}

        <dl className="grid grid-cols-2 divide-x divide-y divide-line border-b border-line bg-surface/90 sm:grid-cols-4 sm:divide-y-0">
          {[
            { term: "Tempo", value: `${Math.round(trackMap.tempo.bpm)} BPM` },
            { term: "Key", value: `${trackMap.key.tonic} ${trackMap.key.mode}` },
            { term: "Range", value: rangeText },
            { term: "First note", value: entersText },
          ].map((stat) => (
            <div key={stat.term} className="px-5 py-4">
              <dt className="text-xs text-muted">{stat.term}</dt>
              <dd className="mt-1 truncate text-xl font-semibold tracking-tight text-text">{stat.value}</dd>
            </div>
          ))}
        </dl>

        {/* Chords Progression Harmonic Strip */}
        <div className="flex h-14 items-stretch border-b border-line">
          <div className="mono-num flex w-36 shrink-0 items-center justify-between border-r border-line bg-surface px-4 text-xs font-semibold text-muted sm:w-48">
            <span>Chords</span>
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
                  className={`flex flex-col cursor-pointer items-center justify-center p-1 transition ${
                    active
                      ? "bg-accent text-accent-ink font-bold shadow-xs"
                      : "text-text hover:bg-surface-2/60"
                  }`}
                >
                  <span className="text-xs font-semibold leading-tight">{chord.label}</span>
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
            {notes.length === 0 ? (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center p-4 text-center text-sm text-muted">
                {notesPending
                  ? "Reading the notes…"
                  : "No notes for this sound. Mixray writes notes for vocals, bass, guitar and piano."}
              </p>
            ) : null}
          </div>
        </div>

      </section>

      {/* Side Intelligence & Recipe Panel */}
      <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-line bg-surface p-5 lg:w-84 lg:border-t-0 lg:border-l lg:overflow-y-auto">
        {summaryText !== undefined ? (
          <p className="text-sm leading-relaxed text-text">{summaryText}</p>
        ) : null}
        <p className="text-xs leading-relaxed text-muted">
          Notes, tempo, key and chords are read automatically, so some may be wrong. Trust your ear.
        </p>

        <div className="border-t border-line pt-4">
          <RecipeCard recipe={selectedIsolation?.recipe} />
        </div>

        {/* Primary CTA Button */}
        <div className="mt-auto border-t border-line pt-4">
          <Link
            href={learnHref}
            className="flex h-10 w-full items-center justify-center rounded-icon bg-accent text-xs font-bold text-accent-ink shadow-sm transition hover:opacity-95"
          >
            Practice on keys
          </Link>
        </div>
      </aside>
    </>
  );
}
