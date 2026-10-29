"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { parseVoiceCoachCommand, type CoachAction } from "@/lib/coach";
import type { ScoreBar, ScoreResult } from "@/lib/score";
import { useStudio } from "./StudioContext";

export interface CoachPanelProps {
  scoreResult: ScoreResult;
  takeHref: string;
  onAnalyzeTake: () => void;
}

interface SpeechRecognitionResultItem {
  transcript: string;
}

interface SpeechRecognitionResultList {
  [index: number]: SpeechRecognitionResultItem[];
  length: number;
}

interface SpeechRecognitionEventLike {
  results: SpeechRecognitionResultList;
}

interface SpeechRecognitionInstanceLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
}

type SpeechConstructor = new () => SpeechRecognitionInstanceLike;

function isSpeechConstructor(val: unknown): val is SpeechConstructor {
  return typeof val === "function";
}

function getSpeechRecognitionClass(): SpeechConstructor | null {
  if (typeof window === "undefined") return null;
  const standard = Reflect.get(window, "SpeechRecognition");
  if (isSpeechConstructor(standard)) return standard;
  const webkit = Reflect.get(window, "webkitSpeechRecognition");
  if (isSpeechConstructor(webkit)) return webkit;
  return null;
}


function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

function formatOffsetMs(offsetMs: number): string {
  const rounded = Math.round(offsetMs);
  return `${rounded >= 0 ? "+" : ""}${rounded} ms ${rounded >= 0 ? "late" : "early"}`;
}

export function CoachPanel({ scoreResult, takeHref, onAnalyzeTake }: CoachPanelProps) {
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
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [isTextInputOpen, setIsTextInputOpen] = useState<boolean>(false);
  const [textCommand, setTextCommand] = useState<string>("");

  const speechInstanceRef = useRef<SpeechRecognitionInstanceLike | null>(null);

  const handleApplyAction = useCallback(
    (action: CoachAction, sourceNotice: string) => {
      applyCoachAction(action);
      setVoiceNotice(sourceNotice);
    },
    [applyCoachAction],
  );

  const startListening = useCallback(() => {
    const SpeechCtor = getSpeechRecognitionClass();
    if (SpeechCtor === null) {
      setVoiceNotice("Speech recognition unavailable in this browser. Use text command below.");
      setIsTextInputOpen(true);
      return;
    }

    try {
      if (speechInstanceRef.current !== null) {
        speechInstanceRef.current.stop();
        speechInstanceRef.current = null;
      }

      const instance = new SpeechCtor();
      instance.continuous = false;
      instance.interimResults = false;
      instance.lang = "en-US";

      instance.onresult = (event) => {
        const transcript = event.results[0]?.[0]?.transcript?.trim() ?? "";
        if (transcript.length === 0) return;

        const action = parseVoiceCoachCommand(transcript);
        if (action !== null) {
          handleApplyAction(action, `Voice applied: "${transcript}"`);
        } else {
          setVoiceNotice(`Heard: "${transcript}". Analyzing take...`);
          onAnalyzeTake();
        }
      };

      instance.onerror = () => {
        setIsListening(false);
      };

      instance.onend = () => {
        setIsListening(false);
      };

      speechInstanceRef.current = instance;
      instance.start();
      setIsListening(true);
      setVoiceNotice("Listening... speak a command (e.g. 'loop bars 1 to 4', 'slow to 75%')");
    } catch {
      setIsListening(false);
      setIsTextInputOpen(true);
    }
  }, [handleApplyAction, onAnalyzeTake]);

  const stopListening = useCallback(() => {
    if (speechInstanceRef.current !== null) {
      speechInstanceRef.current.stop();
      speechInstanceRef.current = null;
    }
    setIsListening(false);
  }, []);

  useEffect(() => {
    return () => {
      if (speechInstanceRef.current !== null) {
        speechInstanceRef.current.stop();
        speechInstanceRef.current = null;
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
          className="h-8 w-full cursor-pointer rounded-icon border border-line-2 bg-surface-2 text-xs font-semibold text-text transition hover:border-control hover:bg-surface"
        >
          Analyze take &amp; loop problem
        </button>

        {/* Hold to talk push-to-talk button */}
        <button
          type="button"
          aria-pressed={isListening}
          onMouseDown={startListening}
          onMouseUp={stopListening}
          onTouchStart={startListening}
          onTouchEnd={stopListening}
          className={`h-9 w-full cursor-pointer select-none rounded-icon text-xs font-semibold transition flex items-center justify-center gap-2 ${
            isListening
              ? "bg-accent text-accent-ink shadow-md shadow-accent/25 animate-pulse"
              : "bg-text text-bg hover:opacity-95"
          }`}
        >
          <span className="h-2 w-2 rounded-full bg-current" />
          <span>{isListening ? "Listening... (Release to apply)" : "Hold to talk"}</span>
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
      <div className="space-y-1.5 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Applied Tool Calls</span>
          {coachEntries.length > 0 ? (
            <button
              type="button"
              onClick={resetCoachOverrides}
              className="mono-num text-[10px] text-muted hover:text-text underline cursor-pointer"
            >
              Reset all
            </button>
          ) : null}
        </div>

        {coachEntries.length > 0 ? (
          <div className="mono-num space-y-1 text-xs">
            {coachEntries.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center justify-between rounded-icon border border-line-2 bg-inset px-2.5 py-1.5 text-text"
              >
                <div className="flex items-center gap-1.5 truncate">
                  <span className="text-accent font-semibold">✓</span>
                  <span className="truncate">{entry.summary}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="mono-num rounded-icon border border-dashed border-line-2 bg-inset/50 px-2.5 py-2 text-[11px] text-muted">
            No active coach overrides (100% tempo, full arrangement).
          </div>
        )}
      </div>

      {/* Per-Bar Accuracy 8-Bar Chart */}
      <div className="space-y-1.5 border-t border-line pt-3">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Per-Bar Accuracy</span>
          <span className="mono-num text-[10px] text-muted">8-BAR STRIP</span>
        </div>

        <div
          role="img"
          aria-label="Per-bar hit and on-time rate chart; bars without played notes are unattempted"
          className="grid h-20 grid-cols-8 items-end gap-1.5 rounded-well border border-line bg-inset p-2 select-none"
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
