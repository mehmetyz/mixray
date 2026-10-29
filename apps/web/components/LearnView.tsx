"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { drawLearnPianoRoll, type PlayedNoteDot } from "@/lib/studio/canvas";
import { midiToNoteName } from "@/lib/studio/format";
import {
  scorePerformance,
  type ScoreBar,
  type ScoreInput,
  type ScoreNote,
  type ScoreResult,
} from "@/lib/score";
import {
  connectWebMidi,
  createNoteStream,
  type MidiDevice,
  type NoteStream,
} from "@/lib/midi";
import {
  lookupShortcutKey,
  playMonitorNote,
  TWO_OCTAVE_KEYS,
} from "@/lib/studio/synth-key";
import type { Note } from "@/lib/trackmap/trackmap.generated";
import { useStudio, type HandFilter } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";
import { CoachPanel } from "./CoachPanel";

type DifficultyLevel = "easy" | "intermediate";

type ProblemBarDetails = {
  reason: string;
};

const WHITE_KEYS = TWO_OCTAVE_KEYS.filter((k) => !k.isSharp);

const BLACK_KEY_LEFT_PERCENT: Record<number, number> = {
  61: 5.2,
  63: 12.3,
  66: 26.6,
  68: 33.8,
  70: 40.9,
  73: 55.2,
  75: 62.3,
  78: 76.6,
  80: 83.8,
  82: 90.9,
};

function filterArrangementNotes(
  notes: Note[],
  handFilter: HandFilter,
  simplifiedBars: number[],
): Note[] {
  return notes.filter((note, idx) => {
    if (handFilter !== "both" && note.hand !== undefined && note.hand !== handFilter) {
      return false;
    }
    if (note.bar !== undefined && simplifiedBars.includes(note.bar + 1) && idx % 2 === 1) {
      return false;
    }
    return true;
  });
}

function toScoreReferenceNotes(notes: Note[]): ScoreNote[] {
  return notes.map((note) => ({ onsetSeconds: note.start, pitch: note.pitch }));
}

function toScorePlayedNotes(notes: PlayedNoteDot[]): ScoreNote[] {
  return notes.map((note) => ({ onsetSeconds: note.time, pitch: note.pitch }));
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatOffset(offsetMs: number): string {
  const rounded = Math.round(offsetMs);
  return `${rounded >= 0 ? "+" : ""}${rounded} ms ${rounded >= 0 ? "late" : "early"}`;
}

function describeProblemBar(bar: ScoreBar): ProblemBarDetails {
  if (bar.wrongPitch > 0) {
    return { reason: `${bar.wrongPitch} wrong pitch${bar.wrongPitch === 1 ? "" : "es"}` };
  }
  if (bar.missed > 0) {
    return { reason: `${bar.missed} missed note${bar.missed === 1 ? "" : "s"}` };
  }
  if (bar.meanOffsetMs !== null && Math.abs(bar.meanOffsetMs) > 50) {
    return { reason: formatOffset(bar.meanOffsetMs) };
  }
  if (bar.extra > 0) {
    return { reason: `${bar.extra} extra note${bar.extra === 1 ? "" : "s"}` };
  }
  return { reason: `${formatPercent(bar.onTimeRate)} on time` };
}

function isWorseProblemBar(candidate: ScoreBar, current: ScoreBar): boolean {
  if (candidate.onTimeRate !== current.onTimeRate) {
    return candidate.onTimeRate < current.onTimeRate;
  }
  if (candidate.hitRate !== current.hitRate) {
    return candidate.hitRate < current.hitRate;
  }
  const candidateErrors = candidate.missed + candidate.wrongPitch + candidate.extra;
  const currentErrors = current.missed + current.wrongPitch + current.extra;
  if (candidateErrors !== currentErrors) return candidateErrors > currentErrors;
  return candidate.index < current.index;
}

export function LearnView() {
  const {
    clipId,
    trackMap,
    selectedIsolation,
    selectedIsolationId,
    currentTime,
    duration,
    seek,
    monitor,
    setMonitor,
    loopRange,
    problemBar,
    handFilter,
    simplifiedBars,
    applyCoachAction,
    resetCoachOverrides,
  } = useStudio();

  const [level, setLevel] = useState<DifficultyLevel>("easy");
  const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([]);
  const [selectedMidiId, setSelectedMidiId] = useState<string>("qwerty");
  const [playedDots, setPlayedDots] = useState<PlayedNoteDot[]>([]);
  const [lastPlayedLabel, setLastPlayedLabel] = useState<string>("Ready · press A–L");

  const rollCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentTimeRef = useRef<number>(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  const [noteStream, setNoteStream] = useState<NoteStream | null>(null);

  const activeNotes = useMemo(() => {
    if (selectedIsolation === undefined) return [];
    const base =
      level === "intermediate" && selectedIsolation.arrangements.intermediate !== undefined
        ? selectedIsolation.arrangements.intermediate
        : selectedIsolation.arrangements.easy;
    return filterArrangementNotes(base, handFilter, simplifiedBars);
  }, [selectedIsolation, level, handFilter, simplifiedBars]);

  const soundingMidis = useMemo(() => {
    const active = new Set<number>();
    for (const note of activeNotes) {
      if (currentTime >= note.start && currentTime < note.end) {
        active.add(note.pitch);
      }
    }
    return active;
  }, [activeNotes, currentTime]);

  const scoreResult = useMemo<ScoreResult>(() => {
    const scoreInput: ScoreInput = {
      referenceNotes: toScoreReferenceNotes(activeNotes),
      playedNotes: toScorePlayedNotes(playedDots),
      downbeats: trackMap.downbeats,
      durationSeconds: duration,
    };
    return scorePerformance(scoreInput);
  }, [activeNotes, playedDots, trackMap.downbeats, duration]);

  const handleUserNote = useCallback(
    (midi: number) => {
      noteStream?.emitNoteOn(midi, 96, "screen");
    },
    [noteStream],
  );

  useEffect(() => {
    const stream = createNoteStream(() => currentTimeRef.current);
    setNoteStream(stream);

    const unsubscribe = stream.subscribe((event) => {
      if (event.kind === "note_on") {
        playMonitorNote(event.pitch);
        setLastPlayedLabel(`${midiToNoteName(event.pitch)} · MIDI ${event.pitch}`);
        setPlayedDots((prev) => [
          ...prev.slice(-48),
          { time: event.onsetSeconds, pitch: event.pitch, offsetMs: 0 },
        ]);
      }
    });

    return () => {
      unsubscribe();
      stream.dispose();
      setNoteStream(null);
    };
  }, []);

  useEffect(() => {
    if (noteStream === null) return;
    return connectWebMidi(
      noteStream,
      (devices) => setMidiDevices(devices),
      selectedMidiId,
    );
  }, [noteStream, selectedMidiId]);

  useEffect(() => {
    if (noteStream === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      const mapped = lookupShortcutKey(event.key);
      if (mapped !== undefined) {
        noteStream.emitNoteOn(mapped.midi, 96, "qwerty");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const mapped = lookupShortcutKey(event.key);
      if (mapped !== undefined) {
        noteStream.emitNoteOff(mapped.midi, "qwerty");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [noteStream]);

  useEffect(() => {
    if (rollCanvasRef.current === null) return;
    drawLearnPianoRoll({
      canvas: rollCanvasRef.current,
      notes: activeNotes,
      played: playedDots,
      currentTime,
      duration,
      downbeats: trackMap.downbeats,
      loop: loopRange,
      problemBarZeroBased: problemBar !== null ? problemBar.bar - 1 : null,
    });
  }, [activeNotes, playedDots, currentTime, duration, trackMap.downbeats, loopRange, problemBar]);

  const analyzeLastTake = () => {
    const attemptedBars = scoreResult.bars.filter((bar) => bar.attempted);
    const firstAttemptedBar = attemptedBars[0];
    if (firstAttemptedBar === undefined) {
      return;
    }

    let problem = firstAttemptedBar;
    for (const bar of attemptedBars.slice(1)) {
      if (isWorseProblemBar(bar, problem)) problem = bar;
    }

    const problemDetails = describeProblemBar(problem);
    const problemBarNumber = problem.index + 1;
    const loopStart = Math.max(1, problemBarNumber - 1);
    const loopEnd = Math.min(16, problemBarNumber + 2);
    applyCoachAction({
      name: "mark_problem_bar",
      args: { bar: problemBarNumber, reason: problemDetails.reason },
    });
    applyCoachAction({ name: "set_loop", args: { start_bar: loopStart, end_bar: loopEnd } });
    applyCoachAction({ name: "set_tempo", args: { percent: 75 } });
  };

  const scrubRoll = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    seek(Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)) * duration);
  };

  const takeHref =
    selectedIsolationId.length > 0
      ? `/c/${encodeURIComponent(clipId)}/take?iso=${encodeURIComponent(selectedIsolationId)}`
      : `/c/${encodeURIComponent(clipId)}/take`;

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-bg lg:overflow-y-auto">
        <TimelineRuler />

        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-2.5">
            <div
              role="group"
              aria-label="Arrangement difficulty"
              className="flex rounded-icon border border-line-2 bg-inset p-0.5"
            >
              <button
                type="button"
                aria-pressed={level === "easy"}
                onClick={() => setLevel("easy")}
                className={`cursor-pointer rounded-icon px-2.5 py-0.5 font-medium ${
                  level === "easy" ? "bg-text text-bg" : "text-text-2 hover:text-text"
                }`}
              >
                Easy
              </button>
              <button
                type="button"
                aria-pressed={level === "intermediate"}
                onClick={() => setLevel("intermediate")}
                className={`cursor-pointer rounded-icon px-2.5 py-0.5 font-medium ${
                  level === "intermediate" ? "bg-text text-bg" : "text-text-2 hover:text-text"
                }`}
              >
                Intermediate
              </button>
            </div>

            <div
              role="group"
              aria-label="Practice backing audio"
              className="flex rounded-icon border border-line-2 bg-inset p-0.5"
            >
              <button
                type="button"
                aria-pressed={monitor === "sound"}
                onClick={() => setMonitor("sound")}
                className={`cursor-pointer rounded-icon px-2.5 py-0.5 ${
                  monitor === "sound" ? "bg-surface-2 font-medium text-text" : "text-muted hover:text-text"
                }`}
              >
                Hear: Sound
              </button>
              <button
                type="button"
                aria-pressed={monitor === "mix"}
                onClick={() => setMonitor("mix")}
                className={`cursor-pointer rounded-icon px-2.5 py-0.5 ${
                  monitor === "mix" ? "bg-surface-2 font-medium text-text" : "text-muted hover:text-text"
                }`}
              >
                With mix
              </button>
            </div>

            {problemBar !== null ? (
              <span className="mono-num inline-flex items-center gap-2 rounded-icon border border-you bg-inset px-2 py-0.5 text-you">
                <span>
                  Bar {problemBar.bar} · {problemBar.reason}
                </span>
                <button
                  type="button"
                  onClick={resetCoachOverrides}
                  className="cursor-pointer text-muted hover:text-text"
                >
                  ×
                </button>
              </span>
            ) : null}
          </div>

          <div className="flex items-center gap-3">
            <span className="mono-num hidden text-muted xl:inline">
              ■ ref · ● your take · ■ left hand
            </span>
            <label className="flex items-center gap-1.5 text-muted">
              <span className="sr-only">MIDI input</span>
              <select
                value={selectedMidiId}
                onChange={(event) => setSelectedMidiId(event.target.value)}
                className="mono-num h-7 rounded-icon border border-line-2 bg-inset px-2 text-xs text-text"
              >
                <option value="qwerty">MIDI: On-screen + QWERTY (A–L)</option>
                {midiDevices.map((dev) => (
                  <option key={dev.id} value={dev.id}>
                    MIDI: {dev.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div
          onClick={scrubRoll}
          className="relative h-64 shrink-0 cursor-pointer border-b border-line bg-inset"
        >
          <canvas
            ref={rollCanvasRef}
            width={1024}
            height={256}
            role="img"
            aria-label={`Interactive piano roll showing ${activeNotes.length} notes and ${playedDots.length} user notes`}
            className="block h-full w-full"
          />
        </div>

        <div className="flex flex-col gap-2 bg-surface p-4">
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="mono-num">C4 – B5 · Click keys, press A–L, or connect USB MIDI</span>
            <span className="mono-num text-text-2">{lastPlayedLabel}</span>
          </div>

          <div className="relative h-32 w-full select-none overflow-x-auto rounded-well border border-line bg-inset p-1.5">
            <div className="relative flex h-full min-w-[560px] gap-1">
              {WHITE_KEYS.map((keySpec) => {
                const active = soundingMidis.has(keySpec.midi);
                return (
                  <button
                    key={keySpec.midi}
                    type="button"
                    aria-label={`Play ${keySpec.note}`}
                    onMouseDown={() => handleUserNote(keySpec.midi)}
                    className={`flex h-full flex-1 cursor-pointer flex-col items-center justify-between rounded-icon border py-2 text-xs mono-num transition ${
                      active
                        ? "border-accent bg-accent font-semibold text-accent-ink"
                        : "border-line-2 bg-key-white text-key-white-ink hover:opacity-95"
                    }`}
                  >
                    <span className={active ? "text-accent-ink opacity-75" : "text-muted"}>
                      {keySpec.shortcut}
                    </span>
                    <span className="font-medium">{keySpec.note}</span>
                  </button>
                );
              })}

              {TWO_OCTAVE_KEYS.filter((k) => k.isSharp).map((sharpKey) => {
                const leftPct = BLACK_KEY_LEFT_PERCENT[sharpKey.midi] ?? 10;
                const active = soundingMidis.has(sharpKey.midi);
                return (
                  <button
                    key={sharpKey.midi}
                    type="button"
                    aria-label={`Play ${sharpKey.note}`}
                    onMouseDown={() => handleUserNote(sharpKey.midi)}
                    style={{ left: `${leftPct}%` }}
                    className={`mono-num absolute top-0 z-10 flex h-[60%] w-[4.4%] cursor-pointer flex-col items-center justify-between rounded-b-icon border py-1.5 text-[10px] transition ${
                      active
                        ? "border-accent bg-accent font-semibold text-accent-ink"
                        : "border-control bg-key-black text-text-2 hover:text-text"
                    }`}
                  >
                    <span className="opacity-70">{sharpKey.shortcut}</span>
                    <span>{sharpKey.note.replace(/\d/, "")}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <CoachPanel
        scoreResult={scoreResult}
        takeHref={takeHref}
        onAnalyzeTake={analyzeLastTake}
      />
    </>
  );
}
