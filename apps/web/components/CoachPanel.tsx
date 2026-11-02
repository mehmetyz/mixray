"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import { playEarcon } from "@/lib/audio/earcons";
import { VoiceRecordingError, listenForPhrase } from "@/lib/audio/voice";
import { talkBindingLabel, type TalkBinding } from "@/lib/midi";
import type { ScoreBar, ScoreResult } from "@/lib/score";
import { STEP_LABELS } from "@/lib/steps";
import { barAtTime, keyLabel, tempoLabel } from "@/lib/studio/format";
import {
  VOICE_COMMAND_HELP,
  matchSoundByName,
  isExactCommand,
  isLatinScript,
  parseVoiceAssistantMessage,
  type PracticeLevel,
  type StudioCommand,
  type VoiceIntent,
} from "@/lib/voice-commands";
import { requestVoiceIntent } from "@/lib/voice-intent";
import { useStudio } from "./StudioContext";

export interface CoachPanelProps {
  scoreResult: ScoreResult;
  takeHref: string;
  onAnalyzeTake: () => void;
  coachMessage: string | null;
  isCoachThinking: boolean;
  talkTriggerRef: RefObject<() => void>;
  talkBinding: TalkBinding;
  isChoosingTalkButton: boolean;
  onChooseTalkButton: () => void;
  onResetTalkButton: () => void;
  onSetLevel: (level: PracticeLevel) => void;
  onShiftOctave: (delta: number) => void;
}

type JsonRecord = Record<string, unknown>;

type VoiceResponse = {
  transcript: string;
};

type VoicePhase = "idle" | "opening" | "listening" | "hearing" | "reading";

type VoiceExchange = {
  heard: string;
  reply: string;
};

const VOICE_ENDPOINT = "/api/voice";
const TEMPO_MIN_PERCENT = 40;
const TEMPO_MAX_PERCENT = 100;
// One press can reach us twice when a controller exposes two MIDI ports.
const TALK_DEBOUNCE_MS = 250;

const PHASE_LABELS: Record<VoicePhase, string> = {
  idle: "Press the talk button, then speak",
  opening: "Opening the microphone…",
  listening: "Speak now",
  hearing: "Hearing you…",
  reading: "Reading your command…",
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageFromResponse(value: unknown): string | null {
  return isRecord(value) && typeof value.message === "string" ? value.message : null;
}

function parseVoiceResponse(value: unknown): VoiceResponse | null {
  if (!isRecord(value) || typeof value.transcript !== "string") return null;
  return { transcript: value.transcript.trim() };
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

export function CoachPanel({
  scoreResult,
  takeHref,
  onAnalyzeTake,
  coachMessage,
  isCoachThinking,
  talkTriggerRef,
  talkBinding,
  isChoosingTalkButton,
  onChooseTalkButton,
  onResetTalkButton,
  onSetLevel,
  onShiftOctave,
}: CoachPanelProps) {
  const studio = useStudio();
  const { problemBar, loopBars, setDucked } = studio;
  const router = useRouter();

  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [exchange, setExchange] = useState<VoiceExchange | null>(null);
  const [isHelpOpen, setIsHelpOpen] = useState<boolean>(false);
  const [isTextInputOpen, setIsTextInputOpen] = useState<boolean>(false);
  const [textCommand, setTextCommand] = useState<string>("");

  const runStudioCommand = (command: StudioCommand, description: string): string => {
    const { trackMap, playing, togglePlay, seek, getPlaybackTime, ratePercent } = studio;
    const downbeats = trackMap.downbeats;
    const barCount = Math.max(1, downbeats.length);
    const clampBar = (bar: number) => Math.max(1, Math.min(barCount, bar));
    const seekToBar = (bar: number) => seek(downbeats[clampBar(bar) - 1] ?? 0);
    const currentBar = barAtTime(getPlaybackTime(), downbeats);

    switch (command.name) {
      case "play":
        if (!playing) togglePlay();
        return description;
      case "pause":
        if (playing) togglePlay();
        return description;
      case "restart":
        seek(studio.loopRange?.startSeconds ?? 0);
        if (!playing) togglePlay();
        return description;
      case "seek_bar":
        seekToBar(command.bar);
        return `Bar ${clampBar(command.bar)}`;
      case "seek_relative":
        seekToBar(currentBar + command.bars);
        return `Bar ${clampBar(currentBar + command.bars)}`;
      case "loop_here": {
        const endBar = clampBar(currentBar + command.bars - 1);
        studio.setLoopBars({ startBar: currentBar, endBar });
        return `Looping bars ${currentBar}–${endBar}`;
      }
      case "loop_off":
        studio.setLoopBars(null);
        return description;
      case "tempo_step": {
        const percent = Math.max(
          TEMPO_MIN_PERCENT,
          Math.min(TEMPO_MAX_PERCENT, ratePercent + command.delta),
        );
        studio.setRatePercent(percent);
        return `Tempo ${percent}%`;
      }
      case "monitor":
        studio.setMonitor(command.stem);
        return description;
      case "level":
        onSetLevel(command.level);
        return description;
      case "select_sound": {
        const sound = matchSoundByName(trackMap.isolations, command.sound);
        if (sound === undefined) return `No sound called "${command.sound}" in this clip`;
        studio.selectIsolation(sound.id);
        return `Practicing ${sound.label}`;
      }
      case "go_to":
        router.push(takeHref.replace("/take", `/${command.screen}`));
        return `Opening ${STEP_LABELS[command.screen]}`;
      case "octave":
        onShiftOctave(command.delta);
        return description;
      case "tell":
        if (command.fact === "bar") return `Bar ${currentBar} of ${barCount}`;
        if (command.fact === "tempo") {
          return `${tempoLabel(trackMap.tempo)}, playing at ${ratePercent}%`;
        }
        return keyLabel(trackMap.key);
      case "help":
        setIsHelpOpen(true);
        return description;
    }
  };

  const runIntent = (intent: VoiceIntent): string => {
    switch (intent.kind) {
      case "studio":
        return runStudioCommand(intent.command, intent.description);
      case "action":
        studio.applyCoachAction(intent.action);
        return intent.description;
      case "analyze":
        onAnalyzeTake();
        return intent.description;
      case "reset":
        studio.resetCoachOverrides();
        return intent.description;
      case "greeting":
      case "unknown":
        return intent.description;
    }
  };

  // Always the latest closure: a command must act on the playing state of the moment it was spoken.
  const runCommandRef = useRef<(phrase: string, heard: string) => void>(() => undefined);
  useEffect(() => {
    runCommandRef.current = (phrase, heard) => {
      const { intent } = parseVoiceAssistantMessage(phrase);
      playEarcon(intent.kind === "unknown" ? "unknown" : "done");
      setExchange({ heard, reply: runIntent(intent) });
    };
  });

  const isReadingRef = useRef<boolean>(false);

  const transcribePhrase = useCallback(async (wav: Blob) => {
    isReadingRef.current = true;
    setPhase("reading");
    try {
      const form = new FormData();
      form.append("audio", wav, "command.wav");
      const res = await fetch(VOICE_ENDPOINT, { method: "POST", body: form });
      const json: unknown = await res.json();
      if (!res.ok) {
        playEarcon("unknown");
        setExchange({ heard: "", reply: messageFromResponse(json) ?? "Transcription failed. Try again." });
        return;
      }
      const transcript = parseVoiceResponse(json)?.transcript ?? "";
      if (transcript.length === 0) {
        playEarcon("unknown");
        setExchange({ heard: "", reply: "Didn't catch that. Press and try again." });
        return;
      }
      if (!isLatinScript(transcript)) {
        playEarcon("unknown");
        setExchange({ heard: transcript, reply: "Commands work in English only. Try again." });
        return;
      }
      const meant = isExactCommand(transcript) ? transcript : await requestVoiceIntent(transcript);
      if (meant === null) {
        playEarcon("unknown");
        setExchange({ heard: transcript, reply: "Not a command. Try: back 2 bars, slower, play." });
        return;
      }
      runCommandRef.current(meant, transcript);
    } catch {
      playEarcon("unknown");
      setExchange({ heard: "", reply: "Voice is unavailable. Type the command instead." });
    } finally {
      isReadingRef.current = false;
      setPhase("idle");
    }
  }, []);

  const listeningRef = useRef<AbortController | null>(null);
  const lastPressRef = useRef<number>(0);

  const pressTalk = useCallback(() => {
    const now = performance.now();
    if (isReadingRef.current || now - lastPressRef.current < TALK_DEBOUNCE_MS) return;
    lastPressRef.current = now;

    if (listeningRef.current !== null) {
      listeningRef.current.abort();
      return;
    }
    const controller = new AbortController();
    const { signal } = controller;
    listeningRef.current = controller;
    setPhase("opening");
    const stopListening = () => {
      listeningRef.current = null;
      setDucked(false);
    };
    // A permission prompt can hold the promise open, so cancelling must not wait for it.
    signal.addEventListener("abort", () => {
      stopListening();
      setPhase("idle");
    });
    void listenForPhrase({
      signal,
      onOpen: () => setDucked(true),
      onReady: () => {
        setPhase("listening");
        playEarcon("listening");
      },
      onSpeaking: (speaking) => {
        if (!signal.aborted) setPhase(speaking ? "hearing" : "listening");
      },
    })
      .then((wav) => {
        if (signal.aborted || wav === null) return;
        stopListening();
        void transcribePhrase(wav);
      })
      .catch((err: unknown) => {
        if (signal.aborted) return;
        stopListening();
        setPhase("idle");
        playEarcon("unknown");
        setExchange({
          heard: "",
          reply: err instanceof VoiceRecordingError ? err.message : "Microphone unavailable.",
        });
      });
  }, [setDucked, transcribePhrase]);

  useEffect(() => {
    talkTriggerRef.current = pressTalk;
  }, [pressTalk, talkTriggerRef]);

  useEffect(
    () => () => {
      listeningRef.current?.abort();
    },
    [],
  );

  const handleTextSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = textCommand.trim();
    if (clean.length === 0) return;
    runCommandRef.current(clean, clean);
    setTextCommand("");
  };

  const attemptedBars = scoreResult.bars.filter((b: ScoreBar) => b.attempted);
  const avgHitRate =
    attemptedBars.length > 0
      ? attemptedBars.reduce((sum, b) => sum + b.hitRate, 0) / attemptedBars.length
      : 0;
  const avgOnTimeRate =
    attemptedBars.length > 0
      ? attemptedBars.reduce((sum, b) => sum + b.onTimeRate, 0) / attemptedBars.length
      : 0;

  return (
    <aside className="flex w-full shrink-0 flex-col gap-3.5 border-t border-line bg-surface p-4 lg:w-80 lg:border-t-0 lg:border-l lg:overflow-y-auto">
      {/* Talk button */}
      <div className="space-y-2 border-b border-line pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-semibold text-text">Coach</span>
          <button
            type="button"
            aria-pressed={phase !== "idle" && phase !== "reading"}
            onClick={pressTalk}
            disabled={phase === "reading"}
            className={`h-8 shrink-0 cursor-pointer rounded-icon border px-3 text-xs font-semibold transition disabled:cursor-default ${
              phase === "idle"
                ? "border-line-2 bg-surface-2 text-text hover:border-accent hover:text-accent"
                : "border-accent bg-accent/15 text-accent"
            }`}
          >
            {phase === "idle" ? "Talk (V)" : phase === "reading" ? "Reading…" : "Cancel"}
          </button>
        </div>
        <p role="status" className="text-[11px] text-muted">
          {PHASE_LABELS[phase]}
        </p>
        <p className="text-[11px] leading-relaxed text-muted">
          {isChoosingTalkButton ? (
            <>Press the pedal, pad or button you want to use.</>
          ) : (
            <>Talk button: {talkBindingLabel(talkBinding)}.</>
          )}{" "}
          <button
            type="button"
            onClick={onChooseTalkButton}
            className="cursor-pointer text-text-2 underline underline-offset-2 hover:text-accent"
          >
            {isChoosingTalkButton ? "Cancel" : "Change"}
          </button>
          {talkBinding.kind !== "default" && !isChoosingTalkButton ? (
            <>
              {" "}
              <button
                type="button"
                onClick={onResetTalkButton}
                className="cursor-pointer text-text-2 underline underline-offset-2 hover:text-accent"
              >
                Reset
              </button>
            </>
          ) : null}
        </p>
      </div>

      {/* What was heard and what happened */}
      {exchange !== null ? (
        <div className="rounded-card border border-line-2 bg-inset p-3 text-xs">
          {exchange.heard.length > 0 ? (
            <p className="mb-1 truncate text-muted">&ldquo;{exchange.heard}&rdquo;</p>
          ) : null}
          <p className="font-semibold text-text">{exchange.reply}</p>
        </div>
      ) : null}

      {coachMessage !== null || isCoachThinking ? (
        <div className="rounded-card border border-accent/25 bg-accent/10 p-3 text-xs leading-relaxed text-text">
          <p className={isCoachThinking ? "animate-pulse text-muted" : ""}>
            {isCoachThinking ? "Muse Spark is reading your take…" : coachMessage}
          </p>
        </div>
      ) : null}

      {/* Performance Score & Coach Assessment */}
      <div className="rounded-card border border-line bg-inset p-3 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold text-text">Your take</span>
          {loopBars !== null ? (
            <span className="mono-num rounded-xs border border-line-2 bg-surface px-1.5 py-0.5 text-[10px] text-accent">
              Loop {loopBars.startBar}–{loopBars.endBar}
            </span>
          ) : null}
        </div>

        {problemBar !== null ? (
          <div className="rounded-well border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-500">
            <span className="block font-semibold">Problem Bar {problemBar.bar} Detected</span>
            <span className="block text-text-2 text-[11px] mt-0.5">{problemBar.reason}</span>
          </div>
        ) : attemptedBars.length > 0 ? (
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-icon border border-line-2 bg-surface p-2">
              <span className="text-[10px] text-muted block">Hit Rate</span>
              <span className="mono-num font-semibold text-accent text-sm">
                {formatPercent(avgHitRate)}
              </span>
            </div>
            <div className="rounded-icon border border-line-2 bg-surface p-2">
              <span className="text-[10px] text-muted block">On-Time</span>
              <span className="mono-num font-semibold text-accent text-sm">
                {formatPercent(avgOnTimeRate)}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted leading-relaxed">
            Press play and follow the notes on your keyboard.
          </p>
        )}

        <button
          type="button"
          onClick={onAnalyzeTake}
          disabled={isCoachThinking}
          className="h-8 w-full cursor-pointer rounded-icon border border-line-2 bg-surface-2 text-xs font-semibold text-text transition hover:border-accent hover:text-accent"
        >
          {isCoachThinking ? "Analyzing take…" : "Get feedback"}
        </button>
      </div>

      {/* What can be said */}
      <details
        open={isHelpOpen}
        onToggle={(event) => setIsHelpOpen(event.currentTarget.open)}
        className="rounded-card border border-line bg-inset p-3 text-xs"
      >
        <summary className="cursor-pointer font-semibold text-text">What you can say</summary>
        <dl className="mt-2 space-y-1.5">
          {VOICE_COMMAND_HELP.map((item) => (
            <div key={item.topic}>
              <dt className="text-[11px] font-medium text-text-2">{item.topic}</dt>
              <dd className="text-[11px] leading-relaxed text-muted">{item.examples}</dd>
            </div>
          ))}
        </dl>
      </details>

      {/* Text command, for when speaking is not an option */}
      <div className="pt-1 space-y-2 border-t border-line">
        <button
          type="button"
          onClick={() => setIsTextInputOpen((prev) => !prev)}
          className="h-8 w-full px-2.5 cursor-pointer rounded-icon border border-line-2 bg-surface text-xs text-text-2 hover:border-control"
        >
          {isTextInputOpen ? "Hide text command" : "Type a command"}
        </button>

        {isTextInputOpen ? (
          <form onSubmit={handleTextSubmit} className="flex gap-1.5">
            <input
              type="text"
              value={textCommand}
              onChange={(e) => setTextCommand(e.target.value)}
              placeholder='"loop 4 to 8" or "slower"'
              className="flex-1 rounded-icon border border-line-2 bg-inset px-2.5 py-1 text-xs text-text placeholder:text-muted focus:border-accent focus:outline-none"
            />
            <button
              type="submit"
              className="cursor-pointer rounded-icon bg-text px-3 py-1 text-xs font-semibold text-bg hover:opacity-95"
            >
              Send
            </button>
          </form>
        ) : null}
      </div>

      {/* Take Home Link */}
      <div className="pt-1">
        <Link
          href={takeHref}
          className="flex h-9 w-full items-center justify-center rounded-icon bg-accent text-xs font-semibold text-accent-ink shadow-sm transition hover:opacity-95"
        >
          Continue to Export
        </Link>
      </div>
    </aside>
  );
}
