"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { drawLearnPianoRoll, type PlayedNoteDot } from "@/lib/studio/canvas";
import { midiToNoteName } from "@/lib/studio/format";
import {
  lookupShortcutKey,
  playMonitorNote,
  subscribeWebMidi,
  TWO_OCTAVE_KEYS,
  type MidiDeviceOption,
} from "@/lib/studio/synth-key";
import type { Note } from "@/lib/trackmap/trackmap.generated";
import { useStudio, type HandFilter } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";

type DifficultyLevel = "easy" | "intermediate";

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
    coachEntries,
    applyCoachAction,
    resetCoachOverrides,
  } = useStudio();

  const [level, setLevel] = useState<DifficultyLevel>("easy");
  const [midiDevices, setMidiDevices] = useState<MidiDeviceOption[]>([]);
  const [selectedMidiId, setSelectedMidiId] = useState<string>("qwerty");
  const [playedDots, setPlayedDots] = useState<PlayedNoteDot[]>([]);
  const [lastPlayedLabel, setLastPlayedLabel] = useState<string>("Ready · press A–L");
  const [barScores, setBarScores] = useState<number[]>([92, 88, 94, 90, 91, 86, 89, 93]);
  const [coachFeedback, setCoachFeedback] = useState<string>(
    "Play along on A–L or a MIDI keyboard. Coach measures onset timing (±50 ms window) and pitch per bar.",
  );
  const [voicePromptOpen, setVoicePromptOpen] = useState<boolean>(false);
  const [voiceCommandText, setVoiceCommandText] = useState<string>("");

  const rollCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const currentTimeRef = useRef<number>(currentTime);
  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

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

  const handleUserNote = useCallback(
    (midi: number) => {
      playMonitorNote(midi);
      const now = currentTimeRef.current;
      let nearestOffsetMs = 0;
      let bestDist = Infinity;

      for (const ref of activeNotes) {
        const dist = Math.abs(now - ref.start);
        if (dist < bestDist) {
          bestDist = dist;
          nearestOffsetMs = Math.round((now - ref.start) * 1000);
        }
      }

      setLastPlayedLabel(`${midiToNoteName(midi)} · MIDI ${midi}`);
      setPlayedDots((prev) => [
        ...prev.slice(-48),
        { time: now, pitch: midi, offsetMs: nearestOffsetMs },
      ]);
    },
    [activeNotes],
  );

  useEffect(() => {
    return subscribeWebMidi(
      selectedMidiId,
      (midi) => handleUserNote(midi),
      (devices) => setMidiDevices(devices),
    );
  }, [selectedMidiId, handleUserNote]);

  useEffect(() => {
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
        handleUserNote(mapped.midi);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleUserNote]);

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
    const barCount = Math.min(8, Math.max(1, trackMap.downbeats.length));
    if (playedDots.length >= 3) {
      const nextScores: number[] = [];
      let worstBar = 1;
      let worstScore = 100;
      let worstOffset = 0;

      for (let b = 0; b < barCount; b += 1) {
        const start = trackMap.downbeats[b] ?? 0;
        const end = trackMap.downbeats[b + 1] ?? duration;
        const inBar = playedDots.filter((dot) => dot.time >= start && dot.time < end);
        if (inBar.length === 0) {
          nextScores.push(85);
          continue;
        }
        const meanAbs =
          inBar.reduce((acc, item) => acc + Math.abs(item.offsetMs), 0) / inBar.length;
        const score = Math.max(35, Math.min(99, Math.round(100 - meanAbs * 0.45)));
        nextScores.push(score);
        if (score < worstScore) {
          worstScore = score;
          worstBar = b + 1;
          worstOffset = Math.round(
            inBar.reduce((acc, item) => acc + item.offsetMs, 0) / inBar.length,
          );
        }
      }

      setBarScores(nextScores);
      const sign = worstOffset >= 0 ? "+" : "";
      const reason = `${sign}${worstOffset}ms ${worstOffset >= 0 ? "late" : "early"}`;
      applyCoachAction({ name: "mark_problem_bar", args: { bar: worstBar, reason } });
      applyCoachAction({
        name: "set_loop",
        args: { start_bar: Math.max(1, worstBar - 1), end_bar: Math.min(16, worstBar + 2) },
      });
      applyCoachAction({ name: "set_tempo", args: { percent: 75 } });
      setCoachFeedback(
        `Bar ${worstBar} averaged ${reason}. Looped bars ${Math.max(1, worstBar - 1)}–${Math.min(16, worstBar + 2)} at 75% tempo so your hand settles on the beat.`,
      );
      return;
    }

    // Deterministic take simulation when clicking Analyze before recording MIDI notes
    const targetBar = Math.min(9, Math.max(1, trackMap.downbeats.length > 8 ? 9 : 2));
    setBarScores([93, 90, 92, 89, 91, 48, 86, 94]);
    applyCoachAction({
      name: "mark_problem_bar",
      args: { bar: targetBar, reason: "+74ms late entry" },
    });
    applyCoachAction({
      name: "set_loop",
      args: { start_bar: Math.max(1, targetBar - 1), end_bar: Math.min(16, targetBar + 2) },
    });
    applyCoachAction({ name: "set_tempo", args: { percent: 75 } });
    seek(trackMap.downbeats[Math.max(0, targetBar - 2)] ?? 0);
    setCoachFeedback(
      `Bar ${targetBar} entered +74 ms late on the chord change. Looped bars ${Math.max(1, targetBar - 1)}–${Math.min(16, targetBar + 2)} at 75% rate.`,
    );
  };

  const applyVoicePhrase = () => {
    const lower = voiceCommandText.trim().toLowerCase();
    if (lower.length === 0) return;

    const loopMatch = lower.match(/(\d+)\s*(?:to|-|–)\s*(\d+)/);
    if (loopMatch !== null) {
      const s = Math.max(1, Number(loopMatch[1]));
      const e = Math.max(s + 1, Number(loopMatch[2]));
      applyCoachAction({ name: "set_loop", args: { start_bar: s, end_bar: e } });
      setCoachFeedback(`Voice command applied: looping bars ${s}–${e}.`);
    } else if (lower.includes("slow") || lower.includes("%")) {
      const numMatch = lower.match(/(\d{2,3})/);
      const pct = numMatch !== null ? Math.max(40, Math.min(100, Number(numMatch[1]))) : 70;
      applyCoachAction({ name: "set_tempo", args: { percent: pct } });
      setCoachFeedback(`Voice command applied: playback rate set to ${pct}%.`);
    } else if (lower.includes("left")) {
      applyCoachAction({ name: "switch_hand", args: { hand: "left" } });
      setCoachFeedback("Voice command applied: isolated left-hand accompaniment.");
    } else if (lower.includes("right")) {
      applyCoachAction({ name: "switch_hand", args: { hand: "right" } });
      setCoachFeedback("Voice command applied: isolated right-hand lead.");
    } else {
      analyzeLastTake();
    }
    setVoiceCommandText("");
    setVoicePromptOpen(false);
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

      <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-line bg-surface p-4 lg:w-80 lg:border-t-0 lg:border-l lg:overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Coach</span>
        </div>

        <p className="rounded-well border border-line bg-inset p-3 text-xs leading-relaxed text-text">
          {coachFeedback}
        </p>

        {coachEntries.length > 0 ? (
          <div className="space-y-1">
            <p className="eyebrow">Applied</p>
            <div className="mono-num space-y-1 text-xs">
              {coachEntries.map((entry) => (
                <div
                  key={entry.id}
                  className="rounded-icon border border-line-2 bg-inset px-2.5 py-1.5 text-text"
                >
                  ✓ {entry.summary}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5">
          <button
            type="button"
            onClick={analyzeLastTake}
            className="h-8 w-full cursor-pointer rounded-icon border border-line-2 bg-surface-2 text-xs font-medium text-text hover:border-control"
          >
            Analyze take &amp; loop problem
          </button>

          <button
            type="button"
            aria-pressed={voicePromptOpen}
            onClick={() => setVoicePromptOpen((prev) => !prev)}
            className="h-8 w-full cursor-pointer rounded-icon bg-text text-xs font-semibold text-bg transition hover:opacity-90"
          >
            Voice command
          </button>

          {voicePromptOpen ? (
            <div className="flex gap-1.5 pt-1">
              <input
                type="text"
                value={voiceCommandText}
                onChange={(event) => setVoiceCommandText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") applyVoicePhrase();
                }}
                placeholder="e.g. loop bars 1 to 4, slow 70%"
                className="mono-num h-8 flex-1 rounded-icon border border-line-2 bg-inset px-2 text-xs text-text placeholder:text-muted focus:border-text focus:outline-none"
              />
              <button
                type="button"
                onClick={applyVoicePhrase}
                className="h-8 cursor-pointer rounded-icon border border-line-2 bg-surface-2 px-2.5 text-xs text-text"
              >
                Send
              </button>
            </div>
          ) : null}
        </div>

        <div className="space-y-1.5 border-t border-line pt-3">
          <p className="eyebrow">Accuracy per bar</p>
          <div
            role="img"
            aria-label="Per-bar timing and pitch accuracy chart"
            className="grid h-16 grid-cols-8 items-end gap-1.5 rounded-well border border-line bg-inset p-2"
          >
            {barScores.map((score, idx) => {
              const isProblem = problemBar !== null && problemBar.bar === idx + 1;
              return (
                <div key={idx} className="flex h-full flex-col items-center justify-end gap-1">
                  <div
                    style={{ height: `${Math.max(16, Math.round(score * 0.72))}%` }}
                    className={`w-full rounded-xs ${isProblem ? "bg-you" : "bg-inactive"}`}
                  />
                  <span className={`mono-num text-[10px] ${isProblem ? "text-you" : "text-muted"}`}>
                    {idx + 1}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-auto border-t border-line pt-3">
          <Link
            href={takeHref}
            className="flex h-8 w-full items-center justify-center rounded-icon border border-line-2 bg-bg text-xs font-medium text-text-2 hover:border-control hover:text-text"
          >
            Export stems &amp; MIDI →
          </Link>
        </div>
      </aside>
    </>
  );
}
