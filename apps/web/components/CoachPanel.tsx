"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { VoiceRecordingError, startHandsFreeListening } from "@/lib/audio/voice";
import {
  parseVoiceAssistantMessage,
  type ParsedVoiceMessage,
} from "@/lib/coach";
import type { ScoreBar, ScoreResult } from "@/lib/score";
import { useStudio } from "./StudioContext";

export interface CoachPanelProps {
  scoreResult: ScoreResult;
  takeHref: string;
  onAnalyzeTake: () => void;
  coachMessage: string | null;
  isCoachThinking: boolean;
}

type JsonRecord = Record<string, unknown>;

type VoiceResponse = {
  transcript: string;
};

type ChatMessage = {
  id: string;
  sender: "user" | "mixray";
  text: string;
  time: string;
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function playAssistantChime() {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(587.33, now); // D5
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.1); // A5
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.09, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.24);
  } catch {
    // Ignore audio context exceptions
  }
}

function speakFeedback(text: string) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.pitch = 1.0;
    utterance.lang = "en-US";
    window.speechSynthesis.speak(utterance);
  } catch {
    // Ignore speech synthesis exceptions
  }
}

const VOICE_ENDPOINT = "/api/voice";
const VOICE_PREFERENCE_KEY = "mixray.voice";
const VOICE_OFF = "off";

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
}: CoachPanelProps) {
  const {
    problemBar,
    loopBars,
    applyCoachAction,
    resetCoachOverrides,
    togglePlay,
  } = useStudio();

  // Stable callback refs, so a playback update never restarts the microphone
  const onAnalyzeTakeRef = useRef(onAnalyzeTake);
  useEffect(() => {
    onAnalyzeTakeRef.current = onAnalyzeTake;
  }, [onAnalyzeTake]);

  const applyCoachActionRef = useRef(applyCoachAction);
  useEffect(() => {
    applyCoachActionRef.current = applyCoachAction;
  }, [applyCoachAction]);

  const resetCoachOverridesRef = useRef(resetCoachOverrides);
  useEffect(() => {
    resetCoachOverridesRef.current = resetCoachOverrides;
  }, [resetCoachOverrides]);

  const togglePlayRef = useRef(togglePlay);
  useEffect(() => {
    togglePlayRef.current = togglePlay;
  }, [togglePlay]);

  const [isVoiceOn, setIsVoiceOn] = useState<boolean>(false);
  const [isHearing, setIsHearing] = useState<boolean>(false);
  const [lastActionNotice, setLastActionNotice] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [isTextInputOpen, setIsTextInputOpen] = useState<boolean>(false);
  const [textCommand, setTextCommand] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: "initial-welcome",
      sender: "mixray",
      text: "Turn voice on and keep both hands on the keys. Just say a command: loop 4 to 8, slow 70 percent, play, or analyze my take.",
      time: "Now",
    },
  ]);

  const isTranscribingRef = useRef<boolean>(false);

  const addChatMessage = useCallback((sender: "user" | "mixray", text: string) => {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setMessages((prev) => [
      ...prev.slice(-6),
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sender, text, time },
    ]);
  }, []);

  const executeVoiceIntent = useCallback(
    (parsed: ParsedVoiceMessage, rawTranscript: string) => {
      playAssistantChime();

      addChatMessage("user", rawTranscript);

      const intent = parsed.intent;
      if (intent.kind === "action") {
        applyCoachActionRef.current(intent.action);
        setLastActionNotice(intent.description);
        addChatMessage("mixray", `${intent.description}. Keep practicing!`);
        speakFeedback(intent.description);
      } else if (intent.kind === "analyze") {
        setLastActionNotice("Analyzing performance take...");
        addChatMessage("mixray", "Analyzing your timing and hit rates with Muse Spark...");
        speakFeedback("Analyzing your take.");
        onAnalyzeTakeRef.current();
      } else if (intent.kind === "play_pause") {
        togglePlayRef.current();
        setLastActionNotice("Playback toggled");
        addChatMessage("mixray", "Playback toggled.");
        speakFeedback("Playback toggled.");
      } else if (intent.kind === "reset") {
        resetCoachOverridesRef.current();
        setLastActionNotice("Studio overrides reset");
        addChatMessage("mixray", "Tempo and loop markers restored to default.");
        speakFeedback("Studio reset.");
      } else if (intent.kind === "greeting") {
        setLastActionNotice("Listening! Say a command...");
        addChatMessage("mixray", intent.description);
        speakFeedback("Listening!");
      } else {
        setLastActionNotice(intent.description);
        addChatMessage("mixray", intent.description);
      }
    },
    [addChatMessage],
  );

  const transcribePhrase = useCallback(
    async (wav: Blob) => {
      isTranscribingRef.current = true;
      setIsTranscribing(true);
      try {
        const form = new FormData();
        form.append("audio", wav, "command.wav");
        const res = await fetch(VOICE_ENDPOINT, { method: "POST", body: form });
        const json: unknown = await res.json();
        if (!res.ok) {
          setLastActionNotice(messageFromResponse(json) ?? "Transcription failed");
          return;
        }
        const transcript = parseVoiceResponse(json)?.transcript ?? "";
        if (transcript.length === 0) return;
        const parsed = parseVoiceAssistantMessage(transcript);
        // The microphone is always open, so talk that is not a command is left alone.
        if (parsed.intent.kind === "unknown") {
          setLastActionNotice(`Heard "${transcript}". Not a command.`);
          return;
        }
        executeVoiceIntent(parsed, transcript);
      } catch {
        setLastActionNotice("Voice transcription is unavailable. Try again.");
      } finally {
        isTranscribingRef.current = false;
        setIsTranscribing(false);
      }
    },
    [executeVoiceIntent],
  );

  useEffect(() => {
    if (!isVoiceOn) return;
    let disposed = false;
    let stopListening: (() => Promise<void>) | null = null;
    void startHandsFreeListening({
      onPhrase: (wav) => void transcribePhrase(wav),
      onSpeaking: setIsHearing,
      // Our own spoken feedback must not be heard as a command.
      shouldIgnore: () => isTranscribingRef.current || window.speechSynthesis?.speaking === true,
    })
      .then((stop) => {
        if (disposed) void stop();
        else stopListening = stop;
      })
      .catch((err: unknown) => {
        setIsVoiceOn(false);
        setLastActionNotice(err instanceof VoiceRecordingError ? err.message : "Microphone unavailable");
      });
    return () => {
      disposed = true;
      void stopListening?.();
    };
  }, [isVoiceOn, transcribePhrase]);

  // Someone who already allowed the microphone should not need a free hand to turn voice on again.
  useEffect(() => {
    let cancelled = false;
    let turnedOff = false;
    try {
      turnedOff = window.localStorage.getItem(VOICE_PREFERENCE_KEY) === VOICE_OFF;
    } catch {
      // Storage can be unavailable; voice then simply follows the permission.
    }
    if (turnedOff) return;
    void navigator.permissions
      ?.query({ name: "microphone" })
      .then((status) => {
        if (!cancelled && status.state === "granted") setIsVoiceOn(true);
      })
      .catch(() => {
        // Some browsers cannot be asked about the microphone; the button still works.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleVoice = () => {
    const next = !isVoiceOn;
    setIsVoiceOn(next);
    setIsHearing(false);
    try {
      if (next) window.localStorage.removeItem(VOICE_PREFERENCE_KEY);
      else window.localStorage.setItem(VOICE_PREFERENCE_KEY, VOICE_OFF);
    } catch {
      // The choice still applies for this visit.
    }
  };

  const handleTextSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = textCommand.trim();
    if (clean.length === 0) return;
    const parsed = parseVoiceAssistantMessage(clean);
    executeVoiceIntent(parsed, clean);
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
      {/* Voice Assistant Header */}
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div className="flex items-center gap-2.5">
          <div className="relative flex h-7 w-7 items-center justify-center rounded-full bg-accent/15 text-accent">
            <span
              className={`h-2.5 w-2.5 rounded-full bg-accent transition-all duration-300 ${
                isHearing ? "scale-150 animate-ping" : isVoiceOn ? "animate-pulse" : "opacity-40"
              }`}
            />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-text">Coach</span>
            </div>
            <span className="mono-num block text-[10px] text-muted">
              {!isVoiceOn
                ? "Voice is off"
                : isTranscribing
                  ? "Reading your command…"
                  : isHearing
                    ? "Hearing you…"
                    : "Listening. Just say a command."}
            </span>
          </div>
        </div>

        <button
          type="button"
          aria-pressed={isVoiceOn}
          onClick={toggleVoice}
          className={`shrink-0 cursor-pointer whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
            isVoiceOn
              ? "border border-accent/40 bg-accent/15 text-accent hover:bg-accent/25"
              : "border border-line-2 bg-inset text-muted hover:text-text"
          }`}
        >
          {isVoiceOn ? "Voice: On" : "Voice: Off"}
        </button>
      </div>

      {/* Status Banner */}
      {lastActionNotice !== null ? (
        <div role="status" className="flex items-center justify-between gap-2 rounded-card border border-line-2 bg-inset/90 px-3 py-2 text-xs text-text">
          <span className="truncate">{lastActionNotice}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setLastActionNotice(null)}
            className="cursor-pointer text-muted hover:text-text"
          >
            ×
          </button>
        </div>
      ) : null}

      {/* Assistant Feed */}
      <div className="flex flex-1 flex-col gap-2 rounded-card border border-line bg-inset/60 p-3 min-h-[120px] max-h-[200px] overflow-y-auto">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Assistant Feed
        </span>
        <div className="flex flex-col gap-2">
          {messages.map((m) => (
            <div
              key={m.id}
              className={`flex flex-col rounded-card p-2 text-xs leading-relaxed ${
                m.sender === "user"
                  ? "self-end border border-line-2 bg-surface text-text max-w-[85%]"
                  : "self-start border border-accent/20 bg-accent/5 text-text max-w-[90%]"
              }`}
            >
              <div className="flex items-center justify-between gap-2 text-[10px] text-muted mb-0.5">
                <span className="font-medium text-text-2">
                  {m.sender === "user" ? "You" : "Mixray Coach"}
                </span>
                <span className="mono-num">{m.time}</span>
              </div>
              <p>{m.text}</p>
            </div>
          ))}

          {coachMessage !== null ? (
            <div className="self-start rounded-card border border-accent/25 bg-accent/10 p-2.5 text-xs leading-relaxed text-text max-w-[95%]">
                            <p>{coachMessage}</p>
            </div>
          ) : null}

          {isCoachThinking ? (
            <div className="self-start rounded-card border border-accent/20 bg-accent/5 p-2 text-xs text-muted animate-pulse">
              Muse Spark is evaluating your take...
            </div>
          ) : null}
        </div>
      </div>

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
              placeholder='e.g. "loop 4 to 8" or "slow 70%"'
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
