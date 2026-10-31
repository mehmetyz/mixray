"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { VoiceRecordingError, startVoiceRecording, type VoiceRecording } from "@/lib/audio/voice";
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

interface SpeechRecognitionResultItem {
  transcript: string;
  confidence: number;
}

interface SpeechRecognitionResultList {
  length: number;
  [index: number]: {
    isFinal: boolean;
    length: number;
    [index: number]: SpeechRecognitionResultItem;
  };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEventLike {
  error: string;
  message?: string;
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
    webkitAudioContext?: typeof AudioContext;
  }
}

function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
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
    ratePercent,
    loopBars,
    handFilter,
    simplifiedBars,
    applyCoachAction,
    resetCoachOverrides,
    togglePlay,
  } = useStudio();

  // Stable callback refs to prevent SpeechRecognition effect churn
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

  // Assistant states: Hands-free wake word is OFF by default for optimal performance
  const [isAssistantEnabled, setIsAssistantEnabled] = useState<boolean>(false);
  const [isWakeActive, setIsWakeActive] = useState<boolean>(false);
  const [liveInterimText, setLiveInterimText] = useState<string>("");
  const [lastActionNotice, setLastActionNotice] = useState<string | null>(null);
  const [isSingleTapRecording, setIsSingleTapRecording] = useState<boolean>(false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [isTextInputOpen, setIsTextInputOpen] = useState<boolean>(false);
  const [textCommand, setTextCommand] = useState<string>("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => [
    {
      id: "initial-welcome",
      sender: "mixray",
      text: 'Voice assistant in standby. Tap "Tap to Speak (Mic)" to command, or toggle "Wake Word" for hands-free listening.',
      time: "Now",
    },
  ]);

  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const isAssistantEnabledRef = useRef<boolean>(isAssistantEnabled);
  useEffect(() => {
    isAssistantEnabledRef.current = isAssistantEnabled;
  }, [isAssistantEnabled]);

  const wakeTimerRef = useRef<number | null>(null);
  const voiceRecordingRef = useRef<VoiceRecording | null>(null);
  const lastProcessedTranscriptRef = useRef<string>("");

  const addChatMessage = useCallback((sender: "user" | "mixray", text: string) => {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    setMessages((prev) => [
      ...prev.slice(-6),
      { id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sender, text, time },
    ]);
  }, []);

  const executeVoiceIntent = useCallback(
    (parsed: ParsedVoiceMessage, rawTranscript: string) => {
      // Trigger visual wake glow and audio chime
      setIsWakeActive(true);
      playAssistantChime();
      if (wakeTimerRef.current !== null) {
        window.clearTimeout(wakeTimerRef.current);
      }
      wakeTimerRef.current = window.setTimeout(() => {
        setIsWakeActive(false);
      }, 3500);

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

  // Initialize and run continuous hands-free speech recognition (Web Speech API)
  // Stable effect that does NOT re-run during playback or state updates
  useEffect(() => {
    const SpeechConstructor = getSpeechRecognitionConstructor();
    if (SpeechConstructor === null) {
      return;
    }

    if (!isAssistantEnabled) {
      if (recognitionRef.current !== null) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
      return;
    }

    let disposed = false;
    let restartTimer: number | null = null;
    let recognition: SpeechRecognitionInstance;
    try {
      recognition = new SpeechConstructor();
    } catch {
      return;
    }

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event: SpeechRecognitionEventLike) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res === undefined) continue;
        const item = res[0];
        if (item === undefined) continue;

        const transcript = item.transcript.trim();

        if (res.isFinal) {
          if (transcript.length > 0 && transcript !== lastProcessedTranscriptRef.current) {
            lastProcessedTranscriptRef.current = transcript;
            setLiveInterimText("");
            const parsed = parseVoiceAssistantMessage(transcript);
            if (parsed.wakeWordDetected || parsed.intent.kind !== "unknown") {
              executeVoiceIntent(parsed, transcript);
            }
          }
        } else {
          interim += item.transcript;
        }
      }

      if (interim.length > 0) {
        setLiveInterimText(interim);
        const lowerInterim = interim.toLowerCase();

        // Detect wake word or command immediately in interim results
        if (/\b(?:mix\s*ray|mixray|mix-ray)\b/i.test(lowerInterim)) {
          setIsWakeActive(true);
          const parsedInterim = parseVoiceAssistantMessage(interim);
          if (
            (parsedInterim.intent.kind === "greeting" ||
              parsedInterim.intent.kind === "action" ||
              parsedInterim.intent.kind === "play_pause") &&
            interim !== lastProcessedTranscriptRef.current
          ) {
            lastProcessedTranscriptRef.current = interim;
            executeVoiceIntent(parsedInterim, interim);
          }
        }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEventLike) => {
      if (event.error === "no-speech" || event.error === "network") {
        return;
      }
      if (
        event.error === "not-allowed" ||
        event.error === "service-not-allowed" ||
        event.error === "audio-capture"
      ) {
        setIsAssistantEnabled(false);
        setLastActionNotice("Microphone permission required for hands-free assistant.");
      }
    };

    recognition.onend = () => {
      if (disposed || !isAssistantEnabledRef.current) return;
      // Restart with a safe 1000ms delay to never starve the JS thread
      if (restartTimer !== null) {
        window.clearTimeout(restartTimer);
      }
      restartTimer = window.setTimeout(() => {
        if (disposed || !isAssistantEnabledRef.current) return;
        try {
          recognition.start();
        } catch {
          // already started or blocked
        }
      }, 1000);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // already active
    }

    return () => {
      disposed = true;
      if (restartTimer !== null) {
        window.clearTimeout(restartTimer);
      }
      if (recognitionRef.current !== null) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
        recognitionRef.current = null;
      }
    };
  }, [isAssistantEnabled, executeVoiceIntent]);

  const requestMicAccess = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia) {
        await navigator.mediaDevices.getUserMedia({ audio: true });
        setIsAssistantEnabled(true);
        setLastActionNotice("Microphone connected! Say 'Hello Mixray'.");
      }
    } catch {
      setLastActionNotice("Microphone permission denied in browser settings.");
      setIsAssistantEnabled(false);
    }
  };

  // Single-tap fallback recording (Meta Muse Voice Transcribe route /api/voice)
  const handleSingleTapMic = async () => {
    if (isTranscribing) return;

    if (isSingleTapRecording) {
      setIsSingleTapRecording(false);
      const recording = voiceRecordingRef.current;
      voiceRecordingRef.current = null;
      if (recording === null) return;

      setIsTranscribing(true);
      setLastActionNotice("Transcribing voice command...");
      try {
        const audio = await recording.stop();
        const form = new FormData();
        form.append("audio", audio, "command.wav");
        const res = await fetch(VOICE_ENDPOINT, { method: "POST", body: form });
        const json: unknown = await res.json();
        if (!res.ok) {
          setLastActionNotice(messageFromResponse(json) ?? "Transcription failed");
          return;
        }
        const parsedRes = parseVoiceResponse(json);
        if (parsedRes && parsedRes.transcript.length > 0) {
          const parsed = parseVoiceAssistantMessage(parsedRes.transcript);
          executeVoiceIntent(parsed, parsedRes.transcript);
        } else {
          setLastActionNotice("No speech detected. Try again.");
        }
      } catch (err: unknown) {
        setLastActionNotice(
          err instanceof VoiceRecordingError ? err.message : "Voice processing error",
        );
      } finally {
        setIsTranscribing(false);
      }
    } else {
      try {
        const recording = await startVoiceRecording();
        voiceRecordingRef.current = recording;
        setIsSingleTapRecording(true);
        setLastActionNotice("Recording... tap microphone again to send.");
      } catch (err: unknown) {
        setLastActionNotice(
          err instanceof VoiceRecordingError ? err.message : "Microphone unavailable",
        );
      }
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

  const currentProblemBarNumber = problemBar?.bar;
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
                isWakeActive
                  ? "scale-150 animate-ping"
                  : isAssistantEnabled
                    ? "animate-pulse"
                    : "opacity-40"
              }`}
            />
            {isWakeActive ? (
              <span className="absolute inset-0 rounded-full border border-accent animate-ping" />
            ) : null}
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-text">Mixray Voice AI</span>
              <span className="mono-num rounded-xs border border-accent/30 bg-accent/10 px-1 py-0.2 text-[9px] font-mono font-medium text-accent">
                Meta
              </span>
            </div>
            <span className="mono-num block text-[10px] text-muted">
              {isWakeActive
                ? "⚡ Wake phrase active!"
                : isAssistantEnabled
                  ? 'Listening for "Hello Mixray"'
                  : "Wake word standby (tap to speak)"}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsAssistantEnabled((prev) => !prev)}
          className={`cursor-pointer rounded-full px-2.5 py-1 text-[11px] font-medium transition ${
            isAssistantEnabled
              ? "border border-accent/40 bg-accent/15 text-accent hover:bg-accent/25"
              : "border border-line-2 bg-inset text-muted hover:text-text"
          }`}
        >
          {isAssistantEnabled ? "Wake: On" : "Wake: Off"}
        </button>
      </div>

      {/* Active Live Transcript / Status Banner */}
      {isWakeActive ? (
        <div className="rounded-card border border-accent bg-accent/10 px-3 py-2 text-xs font-medium text-accent flex items-center justify-between shadow-xs">
          <span>⚡ Listening: Say a command...</span>
          <span className="font-mono text-[11px]">&quot;Hello Mixray&quot;</span>
        </div>
      ) : liveInterimText.length > 0 ? (
        <div className="rounded-card border border-line-2 bg-inset px-3 py-2 text-xs text-text flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-accent animate-ping shrink-0" />
          <span className="truncate font-mono text-[11px] text-accent">&quot;{liveInterimText}&quot;</span>
        </div>
      ) : lastActionNotice !== null ? (
        <div className="rounded-card border border-line-2 bg-inset/90 px-3 py-2 text-xs text-text flex items-center justify-between">
          <span className="truncate">{lastActionNotice}</span>
          <div className="flex items-center gap-2">
            {!isAssistantEnabled && lastActionNotice.includes("permission") ? (
              <button
                type="button"
                onClick={requestMicAccess}
                className="cursor-pointer rounded-xs bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-ink"
              >
                Connect Mic
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setLastActionNotice(null)}
              className="cursor-pointer text-muted hover:text-text"
            >
              ×
            </button>
          </div>
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
              <span className="block text-[10px] text-accent font-semibold mb-0.5">
                Feedback from Muse Spark
              </span>
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
          <span className="text-[11px] font-semibold text-text">Practice Take Score</span>
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
            Play along using QWERTY keys (A–L) or USB MIDI. Mixray measures accuracy and timing.
          </p>
        )}

        <button
          type="button"
          onClick={onAnalyzeTake}
          disabled={isCoachThinking}
          className="h-8 w-full cursor-pointer rounded-icon border border-line-2 bg-surface-2 text-xs font-semibold text-text transition hover:border-accent hover:text-accent"
        >
          {isCoachThinking ? "Analyzing take…" : "Ask Coach for Feedback"}
        </button>
      </div>

      {/* Quick Interventions */}
      <div className="space-y-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted">
          Quick Actions
        </span>
        <div className="flex flex-wrap gap-1">
          {currentProblemBarNumber !== undefined ? (
            <button
              type="button"
              onClick={() => {
                const s = Math.max(1, currentProblemBarNumber - 1);
                const e = Math.min(16, currentProblemBarNumber + 2);
                applyCoachActionRef.current({ name: "set_loop", args: { start_bar: s, end_bar: e } });
                setLastActionNotice(`Looped bars ${s}–${e}`);
                addChatMessage("mixray", `Looped problem bar ${currentProblemBarNumber} (${s}–${e}).`);
                speakFeedback(`Looped bars ${s} to ${e}`);
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-accent hover:text-accent"
            >
              Loop Bar {currentProblemBarNumber}
            </button>
          ) : null}

          {ratePercent === 100 ? (
            <button
              type="button"
              onClick={() => {
                applyCoachActionRef.current({ name: "set_tempo", args: { percent: 75 } });
                setLastActionNotice("Tempo set to 75%");
                addChatMessage("mixray", "Tempo slowed to 75%.");
                speakFeedback("Tempo slowed to 75%");
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-accent hover:text-accent"
            >
              Slow 75%
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                applyCoachActionRef.current({ name: "set_tempo", args: { percent: 100 } });
                setLastActionNotice("Tempo restored to 100%");
                addChatMessage("mixray", "Tempo restored to 100%.");
                speakFeedback("Tempo restored to 100%");
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-control hover:text-text"
            >
              Reset 100%
            </button>
          )}

          {handFilter !== "right" ? (
            <button
              type="button"
              onClick={() => {
                applyCoachActionRef.current({ name: "switch_hand", args: { hand: "right" } });
                setLastActionNotice("Right hand isolated");
                addChatMessage("mixray", "Right hand isolated.");
                speakFeedback("Right hand isolated");
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-accent hover:text-accent"
            >
              Right Hand
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                applyCoachActionRef.current({ name: "switch_hand", args: { hand: "both" } });
                setLastActionNotice("Both hands enabled");
                addChatMessage("mixray", "Both hands enabled.");
                speakFeedback("Both hands enabled");
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-control hover:text-text"
            >
              Both Hands
            </button>
          )}

          {currentProblemBarNumber !== undefined &&
          !simplifiedBars.includes(currentProblemBarNumber) ? (
            <button
              type="button"
              onClick={() => {
                applyCoachActionRef.current({
                  name: "simplify_bar",
                  args: { bar: currentProblemBarNumber },
                });
                setLastActionNotice(`Simplified bar ${currentProblemBarNumber}`);
                addChatMessage("mixray", `Simplified bar ${currentProblemBarNumber}.`);
                speakFeedback(`Simplified bar ${currentProblemBarNumber}`);
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-accent hover:text-accent"
            >
              Simplify Bar {currentProblemBarNumber}
            </button>
          ) : null}

          {loopBars !== null || ratePercent !== 100 || handFilter !== "both" ? (
            <button
              type="button"
              onClick={() => {
                resetCoachOverridesRef.current();
                setLastActionNotice("All studio overrides reset");
                addChatMessage("mixray", "Reset studio overrides.");
                speakFeedback("Studio overrides reset");
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-muted hover:text-text"
            >
              Reset All
            </button>
          ) : null}
        </div>
      </div>

      {/* Tap-to-Speak Fallback & Optional Text Command */}
      <div className="pt-1 space-y-2 border-t border-line">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleSingleTapMic}
            disabled={isTranscribing}
            className={`flex-1 h-8 cursor-pointer rounded-icon border text-xs font-semibold flex items-center justify-center gap-1.5 transition ${
              isSingleTapRecording
                ? "border-accent bg-accent text-accent-ink animate-pulse"
                : "border-line-2 bg-surface text-text hover:border-control"
            }`}
          >
            <span className="h-2 w-2 rounded-full bg-current" />
            <span>{isSingleTapRecording ? "Tap to Finish" : "Tap to Speak (Mic)"}</span>
          </button>

          <button
            type="button"
            onClick={() => setIsTextInputOpen((prev) => !prev)}
            className="h-8 px-2.5 cursor-pointer rounded-icon border border-line-2 bg-surface text-xs text-text-2 hover:text-text"
          >
            {isTextInputOpen ? "Hide" : "Type"}
          </button>
        </div>

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
          Finished Practice · Export Track →
        </Link>
      </div>
    </aside>
  );
}
