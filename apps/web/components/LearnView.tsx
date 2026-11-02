"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type MouseEvent,
} from "react";
import { arrangementOctaveOffset, KeySampler } from "@/lib/audio/key-sampler";
import { drawLearnPianoRoll, type PlayedNoteDot } from "@/lib/studio/canvas";
import { addToTake, forgetPassed, REWIND_SECONDS, startsNewPass, type PassedNote } from "@/lib/studio/take";
import { midiToNoteName } from "@/lib/studio/format";
import { requestCoach } from "@/lib/coach";
import {
  scorePerformance,
  type ScoreInput,
  type ScoreNote,
  type ScoreResult,
} from "@/lib/score";
import {
  connectWebMidi,
  createNoteStream,
  createTalkControl,
  DEFAULT_TALK_BINDING,
  loadTalkBinding,
  saveTalkBinding,
  subscribeTalkBinding,
  type MidiDevice,
  type NoteStream,
} from "@/lib/midi";
import {
  buildPianoKeys,
  lookupShortcutKey,
  startMonitorNote,
  stopMonitorNote,
} from "@/lib/studio/synth-key";
import type { Note } from "@/lib/trackmap/trackmap.generated";
import type { PracticeLevel } from "@/lib/voice-commands";
import { useStudio, type HandFilter } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";
import { CoachPanel } from "./CoachPanel";
import { useThemeListener } from "./ThemeToggle";

const MIDI_MAX_VELOCITY = 127;
const MIN_OCTAVE_SHIFT = -2;
const MAX_OCTAVE_SHIFT = 2;

const BLACK_KEY_LEFT_PERCENT: readonly number[] = [
  5.2, 12.3, 26.6, 33.8, 40.9, 55.2, 62.3, 76.6, 83.8, 90.9,
];

type TakeDot = PlayedNoteDot & PassedNote;

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

export function LearnView() {
  const {
    clipId,
    trackMap,
    selectedIsolation,
    selectedIsolationId,
    currentTime,
    duration,
    seek,
    getPlaybackTime,
    notesPending,
    playing,
    loopRange,
    problemBar,
    handFilter,
    simplifiedBars,
    applyCoachAction,
    resetCoachOverrides,
  } = useStudio();

  const [level, setLevel] = useState<PracticeLevel>("easy");
  const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([]);
  const [selectedMidiId, setSelectedMidiId] = useState<string>("all");
  const [playedDots, setPlayedDots] = useState<TakeDot[]>([]);
  const passRef = useRef<number>(0);
  const previousTimeRef = useRef<number>(currentTime);
  const [lastPlayedLabel, setLastPlayedLabel] = useState<string>("Ready · press A–L");
  const [octaveShift, setOctaveShift] = useState<number>(0);
  const octaveShiftRef = useRef<number>(octaveShift);
  useEffect(() => {
    octaveShiftRef.current = octaveShift;
  }, [octaveShift]);

  const pianoKeys = useMemo(() => buildPianoKeys(octaveShift), [octaveShift]);
  const whiteKeys = useMemo(() => pianoKeys.filter((k) => !k.isSharp), [pianoKeys]);
  const sharpKeys = useMemo(() => pianoKeys.filter((k) => k.isSharp), [pianoKeys]);

  const themeTick = useThemeListener();

  const rollCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number }>({
    width: 1024,
    height: 320,
  });

  const playingRef = useRef<boolean>(playing);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  const playbackClockRef = useRef(getPlaybackTime);
  useEffect(() => {
    playbackClockRef.current = getPlaybackTime;
  }, [getPlaybackTime]);

  const samplerRef = useRef<KeySampler | null>(null);
  const [sampledSound, setSampledSound] = useState<{ id: string; ready: boolean } | null>(null);
  const soundForKeys = selectedIsolation?.sound_wav_url ?? selectedIsolation?.sound_url;
  const notesForKeys = selectedIsolation?.notes;
  const easyPartForKeys = selectedIsolation?.arrangements?.easy;

  useEffect(() => {
    if (soundForKeys === undefined || notesForKeys === undefined || notesForKeys.length === 0) return;
    const sampler = new KeySampler();
    samplerRef.current = sampler;
    let cancelled = false;
    const offset = arrangementOctaveOffset(easyPartForKeys ?? [], notesForKeys);
    void sampler
      .load(soundForKeys, notesForKeys, offset)
      .catch(() => false)
      .then((ready) => {
        if (!cancelled) setSampledSound({ id: selectedIsolationId, ready });
      });
    return () => {
      cancelled = true;
      samplerRef.current = null;
      void sampler.dispose();
    };
  }, [soundForKeys, notesForKeys, easyPartForKeys, selectedIsolationId]);

  const keySoundLabel =
    sampledSound?.id === selectedIsolationId
      ? sampledSound.ready
        ? `Keys play ${selectedIsolation?.label ?? "this sound"}`
        : "Keys play a simple synth"
      : notesForKeys !== undefined && notesForKeys.length > 0
        ? "Loading key sound…"
        : "Keys play a simple synth";

  const [noteStream, setNoteStream] = useState<NoteStream | null>(null);

  const talkTriggerRef = useRef<() => void>(() => undefined);
  const talkBinding = useSyncExternalStore(
    subscribeTalkBinding,
    loadTalkBinding,
    () => DEFAULT_TALK_BINDING,
  );
  const [isChoosingTalkButton, setIsChoosingTalkButton] = useState<boolean>(false);
  const choosingTalkButtonRef = useRef<boolean>(false);
  useEffect(() => {
    choosingTalkButtonRef.current = isChoosingTalkButton;
  }, [isChoosingTalkButton]);

  // Dynamic responsive canvas sizing
  useEffect(() => {
    const el = canvasContainerRef.current;
    if (el === null) return;
    const updateSize = () => {
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      if (w > 0 && h > 0) {
        setCanvasSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
      }
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const activeNotes = useMemo(() => {
    if (selectedIsolation === undefined) return [];
    const easyArrangement = selectedIsolation.arrangements?.easy;
    const interArrangement = selectedIsolation.arrangements?.intermediate;
    const rawNotes = selectedIsolation.notes ?? [];
    const base =
      level === "intermediate"
        ? (interArrangement && interArrangement.length > 0
            ? interArrangement
            : (easyArrangement && easyArrangement.length > 0 ? easyArrangement : rawNotes))
        : (easyArrangement && easyArrangement.length > 0 ? easyArrangement : rawNotes);
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

  const handleNoteOn = useCallback(
    (midi: number) => {
      noteStream?.emitNoteOn(midi, 96, "screen");
    },
    [noteStream],
  );

  const handleNoteOff = useCallback(
    (midi: number) => {
      noteStream?.emitNoteOff(midi, "screen");
    },
    [noteStream],
  );

  useEffect(() => {
    const stream = createNoteStream(() => playbackClockRef.current());
    setNoteStream(stream);

    const unsubscribe = stream.subscribe((event) => {
      if (event.kind === "note_on") {
        if (samplerRef.current?.noteOn(event.pitch, event.velocity) !== true) {
          startMonitorNote(event.pitch);
        }
        setLastPlayedLabel(`${midiToNoteName(event.pitch)} · MIDI ${event.pitch}`);
        // Keys pressed while paused are for finding notes: there is no moment to score them against.
        if (playingRef.current) {
          setPlayedDots((prev) =>
            addToTake(prev, {
              time: event.onsetSeconds,
              pitch: event.pitch,
              offsetMs: 0,
              pass: passRef.current,
            }),
          );
        }
      } else if (event.kind === "note_off") {
        samplerRef.current?.noteOff(event.pitch);
        stopMonitorNote(event.pitch);
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
      createTalkControl({
        getBinding: loadTalkBinding,
        isLearning: () => choosingTalkButtonRef.current,
        onPress: () => talkTriggerRef.current(),
        onLearned: (binding) => {
          choosingTalkButtonRef.current = false;
          saveTalkBinding(binding);
          setIsChoosingTalkButton(false);
        },
      }),
    );
  }, [noteStream, selectedMidiId]);

  useEffect(() => {
    const from = previousTimeRef.current;
    previousTimeRef.current = currentTime;
    if (startsNewPass(from, currentTime)) {
      passRef.current += 1;
      const pass = passRef.current;
      setPlayedDots((prev) => forgetPassed(prev, currentTime - REWIND_SECONDS, currentTime, pass));
    } else if (playing) {
      const pass = passRef.current;
      setPlayedDots((prev) => forgetPassed(prev, from, currentTime, pass));
    }
  }, [currentTime, playing]);

  const shiftOctave = useCallback((delta: number) => {
    setOctaveShift((prev) => Math.max(MIN_OCTAVE_SHIFT, Math.min(MAX_OCTAVE_SHIFT, prev + delta)));
  }, []);

  const changeLevel = useCallback((next: PracticeLevel) => {
    setPlayedDots([]);
    setLevel(next);
  }, []);

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
      if (event.code === "Space" || event.key === " ") {
        // Space is handled globally by StudioContext
        return;
      }
      if (event.key === "z" || event.key === "Z") {
        shiftOctave(-1);
        return;
      }
      if (event.key === "x" || event.key === "X") {
        shiftOctave(1);
        return;
      }
      if (event.key === "v" || event.key === "V") {
        talkTriggerRef.current();
        return;
      }
      const mapped = lookupShortcutKey(event.key, octaveShiftRef.current);
      if (mapped !== undefined) {
        noteStream.emitNoteOn(mapped.midi, 96, "qwerty");
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const mapped = lookupShortcutKey(event.key, octaveShiftRef.current);
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
  }, [noteStream, shiftOctave]);

  // Frame draw loop - synchronized with canvasSize, playback and theme changes
  useEffect(() => {
    const canvas = rollCanvasRef.current;
    if (canvas === null) return;
    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1;
    const targetW = Math.max(1, Math.round(canvasSize.width * dpr));
    const targetH = Math.max(1, Math.round(canvasSize.height * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    drawLearnPianoRoll({
      canvas,
      notes: activeNotes,
      played: playedDots,
      currentTime,
      duration,
      downbeats: trackMap.downbeats,
      loop: loopRange,
      problemBarZeroBased: problemBar !== null ? problemBar.bar - 1 : null,
      peaks: selectedIsolation?.peaks,
      dpr,
    });
  }, [
    activeNotes,
    playedDots,
    currentTime,
    duration,
    trackMap.downbeats,
    loopRange,
    problemBar,
    themeTick,
    selectedIsolation?.peaks,
    canvasSize,
  ]);

  const [coachMessage, setCoachMessage] = useState<string | null>(null);
  const [isCoachThinking, setIsCoachThinking] = useState<boolean>(false);

  const analyzeLastTake = useCallback(async () => {
    if (activeNotes.length === 0 || scoreResult.bars.length === 0) {
      setCoachMessage("This sound has no notes to score. Pick vocals, bass, guitar or piano.");
      return;
    }
    setIsCoachThinking(true);
    setCoachMessage(null);
    const barCount = scoreResult.bars.length;
    const reply = await requestCoach({
      score: scoreResult.bars,
      barCount,
      // The part counts bars from 0 and velocity in MIDI units; the Coach reads bars from 1 and 0–1.
      notes: activeNotes.map((note) => ({
        start: note.start,
        end: note.end,
        pitch: note.pitch,
        velocity: Math.min(1, note.velocity / MIDI_MAX_VELOCITY),
        bar: note.bar === undefined ? undefined : Math.min(barCount, Math.max(1, note.bar + 1)),
        hand: note.hand,
      })),
    });
    for (const action of reply.actions) {
      applyCoachAction(action);
    }
    setCoachMessage(reply.message);
    setIsCoachThinking(false);
  }, [activeNotes, scoreResult.bars, applyCoachAction]);

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
      <section className="flex min-w-0 flex-1 flex-col h-full bg-bg overflow-hidden">
        <TimelineRuler />

        {/* Top Controls & Sound Selector */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface/95 px-5 py-2.5 text-xs shrink-0">
          <div className="flex flex-wrap items-center gap-3">
            {/* Arrangement Difficulty */}
            <div
              role="group"
              aria-label="Arrangement difficulty"
              className="flex rounded-lg border border-line-2 bg-inset p-0.5"
            >
              <button
                type="button"
                aria-pressed={level === "easy"}
                onClick={() => changeLevel("easy")}
                className={`cursor-pointer rounded-md px-3 py-1 font-medium transition ${
                  level === "easy" ? "bg-text text-bg shadow-xs" : "text-text-2 hover:text-text"
                }`}
              >
                Easy
              </button>
              <button
                type="button"
                aria-pressed={level === "intermediate"}
                onClick={() => changeLevel("intermediate")}
                className={`cursor-pointer rounded-md px-3 py-1 font-medium transition ${
                  level === "intermediate" ? "bg-text text-bg shadow-xs" : "text-text-2 hover:text-text"
                }`}
              >
                Intermediate
              </button>
            </div>

            {problemBar !== null ? (
              <span className="mono-num inline-flex items-center gap-2 rounded-lg border border-you bg-inset px-2.5 py-1 text-you">
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
            <label className="flex items-center gap-2 text-muted">
              <span className="sr-only">MIDI input</span>
              <select
                value={selectedMidiId}
                onChange={(event) => setSelectedMidiId(event.target.value)}
                className="mono-num h-8 rounded-lg border border-line-2 bg-inset px-3 text-xs text-text focus:border-accent focus:outline-none"
              >
                <option value="all">MIDI: All Inputs + QWERTY (A–L)</option>
                {midiDevices.map((dev) => (
                  <option key={dev.id} value={dev.id}>
                    MIDI: {dev.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {/* Practice Roll Container: aligned with TimelineRuler's left gutter */}
        <div className="flex flex-1 min-h-[200px] items-stretch border-b border-line bg-inset overflow-hidden">
          {/* Left Track Info Strip (matches TimelineRuler w-36 sm:w-48) */}
          <div className="flex w-36 sm:w-48 shrink-0 flex-col justify-between border-r border-line bg-surface/85 p-3 select-none">
            <div>
              <span className="mono-num text-xs sm:text-sm font-semibold text-text truncate block mt-0.5">
                {selectedIsolation?.label ?? "Melody"}
              </span>
              <span className="mono-num text-[11px] font-medium text-accent block mt-1">
                {activeNotes.length} notes
              </span>
            </div>

          </div>

          {/* Practice Roll Canvas: fills exactly the same horizontal span as TimelineRuler */}
          <div
            ref={canvasContainerRef}
            onClick={scrubRoll}
            className="relative flex-1 cursor-pointer bg-inset overflow-hidden"
          >
            <canvas
              ref={rollCanvasRef}
              role="img"
              aria-label={`Interactive piano roll showing ${activeNotes.length} notes and ${playedDots.length} user notes`}
              className="absolute inset-0 block h-full w-full"
            />

            {activeNotes.length === 0 ? (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
                <div className="rounded-card border border-line-2 bg-surface/90 p-4 shadow-lg backdrop-blur-xs">
                  {notesPending ? (
                    <p className="text-xs font-semibold text-text">Reading the notes…</p>
                  ) : (
                    <>
                      <p className="text-xs font-semibold text-text">No notes for this sound</p>
                      <p className="mt-1 text-[11px] text-muted">
                        Mixray writes notes for vocals, bass, guitar and piano. You can still listen to this one.
                      </p>
                    </>
                  )}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {/* Virtual Keyboard: positioned at the bottom of the screen */}
        <div className="shrink-0 border-t border-line bg-surface/95 px-4 py-2.5 backdrop-blur-xs shadow-xs">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-1.5">
            <div className="flex items-center justify-between text-xs text-muted">
              <div className="flex items-center gap-2">
                <span className="mono-num text-[11px] font-medium text-text">
                  {octaveShift === 0
                    ? "C4 – B5"
                    : octaveShift === -1
                      ? "C3 – B4 (Warm)"
                      : octaveShift === -2
                        ? "C2 – B3 (Bass)"
                        : octaveShift === 1
                          ? "C5 – B6"
                          : "C6 – B7"} 
                </span>
                <div className="flex items-center rounded-xs border border-line-2 bg-surface p-0.5">
                  <button
                    type="button"
                    onClick={() => shiftOctave(-1)}
                    title="Lower octave (Press Z)"
                    className="cursor-pointer rounded-xs px-1.5 py-0.5 text-[10px] font-semibold text-text-2 hover:bg-surface-2 hover:text-accent active:text-accent"
                  >
                    - Oct (Z)
                  </button>
                  <span className="mono-num border-x border-line-2 px-1.5 text-[10px] text-muted">
                    {octaveShift === 0 ? "Default" : octaveShift > 0 ? `+${octaveShift}` : `${octaveShift}`}
                  </span>
                  <button
                    type="button"
                    onClick={() => shiftOctave(1)}
                    title="Higher octave (Press X)"
                    className="cursor-pointer rounded-xs px-1.5 py-0.5 text-[10px] font-semibold text-text-2 hover:bg-surface-2 hover:text-accent active:text-accent"
                  >
                    + Oct (X)
                  </button>
                </div>
              </div>
              <span className="mono-num text-text-2 text-[11px] font-medium">
                {keySoundLabel} · {lastPlayedLabel}
              </span>
            </div>

            <div className="relative h-28 w-full select-none overflow-x-auto rounded-card border border-line-2 bg-inset p-1.5 shadow-xs">
              <div className="relative flex h-full min-w-[560px] gap-1">
                {whiteKeys.map((keySpec) => {
                  const active = soundingMidis.has(keySpec.midi);
                  return (
                    <button
                      key={keySpec.midi}
                      type="button"
                      aria-label={`Play ${keySpec.note}`}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleNoteOn(keySpec.midi);
                      }}
                      onPointerUp={() => handleNoteOff(keySpec.midi)}
                      onPointerLeave={() => handleNoteOff(keySpec.midi)}
                      onPointerCancel={() => handleNoteOff(keySpec.midi)}
                      className={`flex h-full flex-1 cursor-pointer select-none touch-none flex-col items-center justify-between rounded-icon border py-1.5 text-xs mono-num transition ${
                        active
                          ? "border-accent bg-accent font-semibold text-accent-ink shadow-sm"
                          : "border-line-2 bg-key-white text-key-white-ink hover:opacity-95 active:bg-accent/40"
                      }`}
                    >
                      <span className={active ? "text-accent-ink opacity-75 text-[10px]" : "text-muted text-[10px]"}>
                        {keySpec.shortcut}
                      </span>
                      <span className="font-medium text-[11px]">{keySpec.note}</span>
                    </button>
                  );
                })}

                {sharpKeys.map((sharpKey, sharpIdx) => {
                  const leftPct = BLACK_KEY_LEFT_PERCENT[sharpIdx] ?? 10;
                  const active = soundingMidis.has(sharpKey.midi);
                  return (
                    <button
                      key={sharpKey.midi}
                      type="button"
                      aria-label={`Play ${sharpKey.note}`}
                      onPointerDown={(e) => {
                        e.preventDefault();
                        handleNoteOn(sharpKey.midi);
                      }}
                      onPointerUp={() => handleNoteOff(sharpKey.midi)}
                      onPointerLeave={() => handleNoteOff(sharpKey.midi)}
                      onPointerCancel={() => handleNoteOff(sharpKey.midi)}
                      style={{ left: `${leftPct}%` }}
                      className={`mono-num absolute top-0 z-10 flex h-[60%] w-[4.4%] cursor-pointer select-none touch-none flex-col items-center justify-between rounded-b-icon border py-1 text-[10px] transition ${
                        active
                          ? "border-accent bg-accent font-semibold text-accent-ink shadow-sm"
                          : "border-control bg-key-black text-key-black-ink active:bg-accent/40"
                      }`}
                    >
                      <span className="opacity-70 text-[9px]">{sharpKey.shortcut}</span>
                      <span className="text-[9px]">{sharpKey.note.replace(/\d/, "")}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      <CoachPanel
        scoreResult={scoreResult}
        takeHref={takeHref}
        onAnalyzeTake={analyzeLastTake}
        coachMessage={coachMessage}
        isCoachThinking={isCoachThinking}
        talkTriggerRef={talkTriggerRef}
        talkBinding={talkBinding}
        isChoosingTalkButton={isChoosingTalkButton}
        onChooseTalkButton={() => setIsChoosingTalkButton((choosing) => !choosing)}
        onResetTalkButton={() => saveTalkBinding(DEFAULT_TALK_BINDING)}
        onSetLevel={changeLevel}
        onShiftOctave={shiftOctave}
      />
    </>
  );
}
