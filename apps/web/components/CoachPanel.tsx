"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { VoiceRecordingError, startVoiceRecording, type VoiceRecording } from "@/lib/audio/voice";
import { parseVoiceCoachCommand, type CoachAction } from "@/lib/coach";
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

function formatOffsetMs(offsetMs: number): string {
  const rounded = Math.round(offsetMs);
  return `${rounded >= 0 ? "+" : ""}${rounded} ms ${rounded >= 0 ? "late" : "early"}`;
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
    coachEntries,
    applyCoachAction,
    resetCoachOverrides,
  } = useStudio();

  const [isListening, setIsListening] = useState<boolean>(false);
  const [isTranscribing, setIsTranscribing] = useState<boolean>(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [isTextInputOpen, setIsTextInputOpen] = useState<boolean>(false);
  const [textCommand, setTextCommand] = useState<string>("");

  const voiceRecordingRef = useRef<VoiceRecording | null>(null);
  const isStartingVoiceRef = useRef<boolean>(false);
  const isTalkHeldRef = useRef<boolean>(false);

  const handleApplyAction = useCallback(
    (action: CoachAction, sourceNotice: string) => {
      applyCoachAction(action);
      setVoiceNotice(sourceNotice);
    },
    [applyCoachAction],
  );

  const startListening = useCallback(async () => {
    if (isStartingVoiceRef.current || voiceRecordingRef.current !== null || isTranscribing) return;

    isTalkHeldRef.current = true;
    isStartingVoiceRef.current = true;
    setIsListening(true);
    setVoiceNotice("Listening... speak a command, then release to apply.");

    try {
      const recording = await startVoiceRecording();
      if (!isTalkHeldRef.current) {
        await recording.cancel();
        return;
      }
      voiceRecordingRef.current = recording;
    } catch (error: unknown) {
      const message =
        error instanceof VoiceRecordingError
          ? error.message
          : "Microphone unavailable. Use a text command instead.";
      setVoiceNotice(message);
      setIsTextInputOpen(true);
      setIsListening(false);
    } finally {
      isStartingVoiceRef.current = false;
    }
  }, [isTranscribing]);

  const stopListening = useCallback(async () => {
    isTalkHeldRef.current = false;
    const recording = voiceRecordingRef.current;
    voiceRecordingRef.current = null;
    setIsListening(false);
    if (recording === null) return;

    setIsTranscribing(true);
    setVoiceNotice("Transcribing your command...");
    try {
      const audio = await recording.stop();
      const form = new FormData();
      form.append("audio", audio, "voice-command.wav");
      const response = await fetch(VOICE_ENDPOINT, { method: "POST", body: form });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        setVoiceNotice("The voice transcript could not be read. Try again.");
        return;
      }
      if (!response.ok) {
        setVoiceNotice(messageFromResponse(payload) ?? "Voice transcription failed. Try again.");
        return;
      }

      const voiceResponse = parseVoiceResponse(payload);
      if (voiceResponse === null) {
        setVoiceNotice("The voice transcript could not be read. Try again.");
        return;
      }
      if (voiceResponse.transcript.length === 0) {
        setVoiceNotice("No speech heard. Use a text command or try again.");
        return;
      }

      const action = parseVoiceCoachCommand(voiceResponse.transcript);
      if (action !== null) {
        handleApplyAction(action, `Heard: "${voiceResponse.transcript}". Voice applied.`);
      } else {
        setVoiceNotice(`Heard: "${voiceResponse.transcript}". Analyzing take...`);
        onAnalyzeTake();
      }
    } catch (error: unknown) {
      const message =
        error instanceof VoiceRecordingError ? error.message : "Voice transcription failed. Try again.";
      setVoiceNotice(message);
    } finally {
      setIsTranscribing(false);
    }
  }, [handleApplyAction, onAnalyzeTake]);

  useEffect(() => {
    return () => {
      isTalkHeldRef.current = false;
      const recording = voiceRecordingRef.current;
      voiceRecordingRef.current = null;
      if (recording !== null) {
        void recording.cancel();
      }
    };
  }, []);

  const handleTextSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const clean = textCommand.trim();
    if (clean.length === 0) return;

    const action = parseVoiceCoachCommand(clean);
    if (action !== null) {
      handleApplyAction(action, `Applied command: "${clean}"`);
    } else {
      setVoiceNotice(`Analyzing take for: "${clean}"`);
      onAnalyzeTake();
    }
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
    <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-line bg-surface p-4 lg:w-80 lg:border-t-0 lg:border-l lg:overflow-y-auto">
      {/* Eyebrow & Live Status */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="eyebrow">Voice Coach</span>
          <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
        </div>
        <span className="mono-num rounded-icon border border-line-2 bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-2">
          {loopBars !== null ? `LOOP BARS ${loopBars.startBar}–${loopBars.endBar}` : "MUSE SPARK"}
        </span>
      </div>

      {/* Feedback Card */}
      <div className="rounded-well border border-line bg-inset p-3 text-xs leading-relaxed text-text space-y-2">
        {problemBar !== null ? (
          <div>
            <div className="flex items-center gap-1.5 font-medium text-you">
              <span className="h-2 w-2 rounded-full bg-you" />
              <span>Problem Bar {problemBar.bar} Detected</span>
            </div>
            <p className="mt-1 text-text-2 leading-relaxed">
              Timing or pitch variance exceeds tolerance:{" "}
              <span className="font-semibold text-text">{problemBar.reason}</span>. Focus on this
              phrase to build muscle memory.
            </p>
          </div>
        ) : attemptedBars.length > 0 ? (
          <p className="text-text-2 leading-relaxed">
            Good take registered. Overall hit rate:{" "}
            <span className="font-semibold text-accent">{formatPercent(avgHitRate)}</span>,{" "}
            on-time rate:{" "}
            <span className="font-semibold text-accent">{formatPercent(avgOnTimeRate)}</span>.
          </p>
        ) : (
          <p className="text-muted leading-relaxed">
            Play along using <span className="mono-num text-text">A–L</span> or a connected MIDI
            keyboard. Voice Coach tracks note onsets in a ±50 ms window and pinpoints errors.
          </p>
        )}

        {coachMessage !== null ? (
          <p className="rounded-icon border border-line-2 bg-surface-2 px-2 py-1 text-[11px] leading-relaxed text-text">
            {coachMessage}
          </p>
        ) : null}

        {voiceNotice !== null ? (
          <div className="mono-num rounded-icon border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-accent">
            {voiceNotice}
          </div>
        ) : null}
      </div>

      {/* Primary Coach Controls */}
      <div className="space-y-2">
        <button
          type="button"
          onClick={onAnalyzeTake}
          disabled={isCoachThinking}
          className="h-8 w-full cursor-pointer rounded-icon border border-line-2 bg-surface-2 text-xs font-semibold text-text transition hover:border-control hover:bg-surface"
        >
          {isCoachThinking ? "Asking the Coach…" : "Analyze take & loop problem"}
        </button>

        {/* Hold to talk push-to-talk button */}
        <button
          type="button"
          aria-pressed={isListening}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            void startListening();
          }}
          onPointerUp={() => {
            void stopListening();
          }}
          onPointerCancel={() => {
            void stopListening();
          }}
          disabled={isTranscribing}
          className={`h-9 w-full cursor-pointer select-none rounded-icon text-xs font-semibold transition flex items-center justify-center gap-2 ${
            isListening
              ? "bg-accent text-accent-ink shadow-md shadow-accent/25 animate-pulse"
              : "bg-text text-bg hover:opacity-95"
          }`}
        >
          <span className="h-2 w-2 rounded-full bg-current" />
          <span>
            {isListening
              ? "Listening... (Release to apply)"
              : isTranscribing
                ? "Transcribing..."
                : "Hold to talk"}
          </span>
        </button>

        {/* Quick Action Intervention Chips */}
        <div className="flex flex-wrap gap-1 pt-1">
          {currentProblemBarNumber !== undefined ? (
            <button
              type="button"
              onClick={() => {
                const s = Math.max(1, currentProblemBarNumber - 1);
                const e = Math.min(16, currentProblemBarNumber + 2);
                handleApplyAction(
                  { name: "set_loop", args: { start_bar: s, end_bar: e } },
                  `Looped bars ${s}–${e}`,
                );
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
                handleApplyAction({ name: "set_tempo", args: { percent: 75 } }, "Tempo set to 75%");
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-accent hover:text-accent"
            >
              Slow to 75%
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                handleApplyAction({ name: "set_tempo", args: { percent: 100 } }, "Tempo restored to 100%");
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
                handleApplyAction({ name: "switch_hand", args: { hand: "right" } }, "Right hand isolated");
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-accent hover:text-accent"
            >
              Right hand only
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                handleApplyAction({ name: "switch_hand", args: { hand: "both" } }, "Both hands enabled");
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-control hover:text-text"
            >
              Both hands
            </button>
          )}

          {currentProblemBarNumber !== undefined &&
          !simplifiedBars.includes(currentProblemBarNumber) ? (
            <button
              type="button"
              onClick={() => {
                handleApplyAction(
                  { name: "simplify_bar", args: { bar: currentProblemBarNumber } },
                  `Simplified bar ${currentProblemBarNumber}`,
                );
              }}
              className="mono-num cursor-pointer rounded-icon border border-line-2 bg-inset px-2 py-1 text-[10px] text-text-2 hover:border-accent hover:text-accent"
            >
              Simplify Bar {currentProblemBarNumber}
            </button>
          ) : null}
        </div>

        {/* Text Fallback Command Toggle */}
        <div className="pt-1">
          <button
            type="button"
            onClick={() => setIsTextInputOpen((prev) => !prev)}
            className="mono-num text-[11px] text-muted hover:text-text-2 underline cursor-pointer"
          >
            {isTextInputOpen ? "Hide text command" : "Type a coach command →"}
          </button>

          {isTextInputOpen ? (
            <form onSubmit={handleTextSubmit} className="mt-1.5 flex gap-1.5">
              <input
                type="text"
                value={textCommand}
                onChange={(e) => setTextCommand(e.target.value)}
                placeholder="e.g. loop bars 1 to 4, slow 75%"
                className="mono-num h-8 flex-1 rounded-icon border border-line-2 bg-inset px-2.5 text-xs text-text placeholder:text-muted focus:border-text focus:outline-none"
              />
              <button
                type="submit"
                className="h-8 cursor-pointer rounded-icon border border-line-2 bg-surface-2 px-2.5 text-xs font-medium text-text hover:border-control"
              >
                Send
              </button>
            </form>
          ) : null}
        </div>
      </div>

      {/* Applied Tool Calls Log */}
      <div className="space-y-2 border-t border-line/70 pt-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-text">Applied Coach Overrides</span>
          {coachEntries.length > 0 ? (
            <button
              type="button"
              onClick={resetCoachOverrides}
              className="text-[11px] text-muted hover:text-text underline cursor-pointer"
            >
              Reset all
            </button>
          ) : null}
        </div>

        {coachEntries.length > 0 ? (
          <div className="space-y-1 text-xs">
            {coachEntries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between rounded-card border border-line-2 bg-surface-2/60 px-3 py-1.5 text-text shadow-xs"
              >
                <div className="flex items-center gap-2 truncate">
                  <span className="text-accent font-semibold">✓</span>
                  <span className="truncate text-xs">{entry.summary}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-card border border-dashed border-line-2 bg-surface-2/20 px-3 py-2 text-[11px] text-muted">
            No active coach overrides (100% tempo, full arrangement).
          </div>
        )}
      </div>

      {/* Per-Bar Accuracy 8-Bar Chart */}
      <div className="space-y-2 border-t border-line/70 pt-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-text">Per-Bar Accuracy</span>
          <span className="mono-num text-[10px] text-muted">8-BAR STRIP</span>
        </div>

        <div
          role="img"
          aria-label="Per-bar hit and on-time rate chart; bars without played notes are unattempted"
          className="grid h-20 grid-cols-8 items-end gap-1.5 rounded-card border border-line-2 bg-surface-2/40 p-2.5 select-none shadow-xs"
        >
          {scoreResult.bars.slice(0, 8).map((bar) => {
            const isProblem = problemBar !== null && problemBar.bar === bar.index + 1;
            const rateLabel = bar.attempted
              ? `${formatPercent(bar.hitRate)} hit · ${formatPercent(bar.onTimeRate)} on-time`
              : "not played";
            const barOffset =
              bar.meanOffsetMs !== null ? ` (${formatOffsetMs(bar.meanOffsetMs)})` : "";

            return (
              <div
                key={bar.index}
                title={`Bar ${bar.index + 1}: ${rateLabel}${barOffset}`}
                className="flex h-full flex-col items-center justify-end gap-1"
              >
                <div
                  style={{
                    height: `${bar.attempted ? Math.max(18, Math.round(bar.hitRate * 72)) : 14}%`,
                  }}
                  className={`w-full rounded-xs transition-all ${
                    bar.attempted
                      ? isProblem
                        ? "bg-you shadow-xs shadow-you/50"
                        : "bg-accent/80"
                      : "border border-dashed border-line-2 bg-transparent"
                  }`}
                />
                <span
                  className={`mono-num text-center text-[8px] leading-none font-medium ${
                    isProblem ? "text-you font-bold" : "text-muted"
                  }`}
                >
                  {bar.index + 1}
                </span>
              </div>
            );
          })}
        </div>

        <p className="mono-num text-[10px] text-muted leading-tight">
          Onset timing measured via Web Audio clock in ±50 ms window. Highlighted in{" "}
          <span className="text-you font-medium">rose</span> = problem bar.
        </p>
      </div>

      {/* Export Take Home Link */}
      <div className="mt-auto border-t border-line pt-3">
        <Link
          href={takeHref}
          className="flex h-8 w-full items-center justify-center rounded-icon border border-line-2 bg-bg text-xs font-semibold text-text-2 transition hover:border-control hover:text-text"
        >
          Export stems &amp; MIDI →
        </Link>
      </div>
    </aside>
  );
}
