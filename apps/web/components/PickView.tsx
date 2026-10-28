"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { startIsolation, waitForJob } from "@/lib/engine/client";
import type { JobStage } from "@/lib/engine/types";
import { methodBadgeLabel } from "@/lib/studio/format";
import { useStudio } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";
import { VideoMaskStage } from "./VideoMaskStage";
import { WaveformLanes } from "./WaveformLanes";

const PROGRESS_STAGES: readonly JobStage[] = ["listening", "isolating", "analyzing"];
const LIVE_CLIP_ID_RE = /^[0-9a-f]{64}$/;

export function PickView() {
  const router = useRouter();
  const {
    clipId,
    trackMap,
    selectedIsolation,
    selectedIsolationId,
    selectIsolation,
    fallbackAlternative,
    useDemucsCleaner,
    setUseDemucsCleaner,
    setMonitor,
  } = useStudio();

  const isDemo = !LIVE_CLIP_ID_RE.test(clipId);
  const [demoQuartetMode, setDemoQuartetMode] = useState<boolean>(false);
  const [selectedMaskId, setSelectedMaskId] = useState<string>("violin");
  const [promptInput, setPromptInput] = useState<string>("");
  const [workingStage, setWorkingStage] = useState<JobStage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runOrSelectPrompt = async (prompt: string, label?: string) => {
    const cleanPrompt = prompt.trim();
    if (cleanPrompt.length === 0) return;

    setErrorMessage(null);

    const lower = cleanPrompt.toLowerCase();
    const existing = trackMap.isolations.find(
      (item) =>
        item.prompt.toLowerCase() === lower ||
        item.label.toLowerCase() === (label ?? cleanPrompt).toLowerCase(),
    );

    if (existing !== undefined) {
      selectIsolation(existing.id);
      setMonitor("sound");
      return;
    }

    if (isDemo) {
      const partial = trackMap.isolations.find(
        (item) =>
          lower.includes("piano") || lower.includes("chord") || lower.includes("key")
            ? item.label.toLowerCase().includes("piano")
            : item.label.toLowerCase().includes("lead"),
      );
      if (partial !== undefined) {
        selectIsolation(partial.id);
        setMonitor("sound");
        return;
      }
    }

    setWorkingStage("isolating");
    try {
      const initialJob = await startIsolation({ jobId: clipId, prompt: cleanPrompt, label });
      let finalJob = initialJob;
      if (initialJob.status !== "done") {
        finalJob = await waitForJob(clipId, {
          onStage: (job) => setWorkingStage(job.stage),
        });
      }
      router.refresh();
      if (finalJob.isolationId !== null) {
        selectIsolation(finalJob.isolationId);
        setMonitor("sound");
      }
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not isolate that sound right now.",
      );
    } finally {
      setWorkingStage(null);
    }
  };

  const onPromptSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runOrSelectPrompt(promptInput);
  };

  const xrayHref =
    selectedIsolationId.length > 0
      ? `/c/${encodeURIComponent(clipId)}/xray?iso=${encodeURIComponent(selectedIsolationId)}`
      : `/c/${encodeURIComponent(clipId)}/xray`;

  const rulerToggle =
    trackMap.video === undefined && isDemo ? (
      <div className="mono-num flex items-center gap-1 text-[11px]">
        <button
          type="button"
          aria-pressed={!demoQuartetMode}
          onClick={() => setDemoQuartetMode(false)}
          className={`cursor-pointer rounded-icon px-2 py-0.5 ${
            !demoQuartetMode ? "bg-surface-2 text-text" : "text-muted hover:text-text"
          }`}
        >
          Audio view
        </button>
        <button
          type="button"
          aria-pressed={demoQuartetMode}
          onClick={() => setDemoQuartetMode(true)}
          className={`cursor-pointer rounded-icon px-2 py-0.5 ${
            demoQuartetMode ? "bg-surface-2 text-text" : "text-muted hover:text-text"
          }`}
        >
          Video mask stage
        </button>
      </div>
    ) : undefined;

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-bg lg:overflow-y-auto">
        <TimelineRuler rightSlot={rulerToggle} />

        <VideoMaskStage
          video={trackMap.video}
          demoQuartetMode={demoQuartetMode}
          selectedTargetId={selectedMaskId}
          onSelectTarget={(targetId, prompt, label, isolationId) => {
            setSelectedMaskId(targetId);
            if (isolationId !== undefined) {
              selectIsolation(isolationId);
              setMonitor("sound");
              return;
            }
            void runOrSelectPrompt(prompt, label);
          }}
        />

        <WaveformLanes />

        <div className="flex items-center justify-between px-4 py-2 text-[11px] text-muted">
          <span className="mono-num truncate">
            {selectedIsolation !== undefined
              ? `${selectedIsolation.label} · ${methodBadgeLabel(selectedIsolation.method, useDemucsCleaner)}`
              : "Select a sound"}
          </span>
          <span className="mono-num shrink-0 text-muted">Scrub to seek</span>
        </div>
      </section>

      <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-line bg-surface p-4 lg:w-80 lg:border-t-0 lg:border-l lg:overflow-y-auto">
        <div className="flex items-center justify-between">
          <span className="eyebrow">Isolate</span>
          <span className="mono-num rounded-icon border border-line-2 bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-2">
            {useDemucsCleaner ? "DEMUCS" : "SAM AUDIO"}
          </span>
        </div>

        {errorMessage !== null ? (
          <div
            role="alert"
            className="rounded-icon border border-accent bg-inset px-3 py-2 text-xs text-text"
          >
            {errorMessage}
          </div>
        ) : null}

        {trackMap.suggestions.length > 0 ? (
          <div>
            <p className="mb-2 text-xs text-muted">Suggestions</p>
            <div className="flex flex-wrap gap-1.5">
              {trackMap.suggestions.map((chip) => {
                const active =
                  selectedIsolation !== undefined &&
                  (selectedIsolation.prompt.toLowerCase() === chip.prompt.toLowerCase() ||
                    selectedIsolation.label.toLowerCase() === chip.label.toLowerCase());
                return (
                  <button
                    key={chip.prompt}
                    type="button"
                    aria-pressed={active}
                    disabled={workingStage !== null}
                    onClick={() => void runOrSelectPrompt(chip.prompt, chip.label)}
                    className={`cursor-pointer rounded-icon border px-2.5 py-1 text-xs font-medium transition ${
                      active
                        ? "border-text bg-text text-bg"
                        : "border-line-2 bg-bg text-text-2 hover:border-control hover:text-text"
                    }`}
                  >
                    {chip.label}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <form onSubmit={onPromptSubmit} className="space-y-2 border-t border-line pt-3">
          <label htmlFor="sound-prompt-input" className="block text-xs text-muted">
            Describe sound
          </label>
          <div className="flex gap-1.5">
            <input
              id="sound-prompt-input"
              type="text"
              value={promptInput}
              onChange={(event) => setPromptInput(event.target.value)}
              placeholder="e.g. supersaw lead, cello"
              className="mono-num h-8 flex-1 rounded-icon border border-line-2 bg-inset px-2.5 text-xs text-text placeholder:text-muted focus:border-text focus:outline-none"
            />
            <button
              type="submit"
              disabled={workingStage !== null || promptInput.trim().length === 0}
              className="h-8 cursor-pointer rounded-icon border border-line-2 bg-surface-2 px-3 text-xs font-medium text-text hover:border-control disabled:cursor-not-allowed disabled:opacity-50"
            >
              Go
            </button>
          </div>
        </form>

        {workingStage !== null ? (
          <div className="space-y-1.5 rounded-well border border-line bg-inset p-3 text-xs">
            <div className="mono-num flex flex-wrap items-center gap-1.5">
              {PROGRESS_STAGES.map((stage, idx) => (
                <span key={stage} className="flex items-center gap-1.5">
                  {idx > 0 ? <span className="text-muted">→</span> : null}
                  <span className={stage === workingStage ? "font-semibold text-accent" : "text-muted"}>
                    {stage}
                  </span>
                </span>
              ))}
            </div>
            <p className="text-[11px] text-muted">About 15–20 seconds on GPU (instant if cached).</p>
          </div>
        ) : null}

        {fallbackAlternative !== null ? (
          <div className="border-t border-line pt-4">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={useDemucsCleaner}
                onChange={(event) => setUseDemucsCleaner(event.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 rounded-icon border-control bg-bg accent-text"
              />
              <span className="space-y-0.5 text-xs">
                <span className="block font-medium text-text">
                  Cleaner version (Demucs {fallbackAlternative.name})
                </span>
                <span className="block text-muted">
                  Standard instrument found, try both and keep the clearer one.
                </span>
              </span>
            </label>
          </div>
        ) : null}

        <div className="mt-auto border-t border-line pt-3">
          {selectedIsolation !== undefined ? (
            <Link
              href={xrayHref}
              className="flex h-8 w-full items-center justify-center rounded-icon bg-text text-xs font-semibold text-bg transition hover:opacity-90"
            >
              Continue to X-Ray →
            </Link>
          ) : (
            <span className="flex h-8 w-full cursor-not-allowed items-center justify-center rounded-icon bg-surface-2 text-xs font-semibold text-muted">
              Select a sound
            </span>
          )}
        </div>
      </aside>
    </>
  );
}
