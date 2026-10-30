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
    fallbackComparison,
    useDemucsCleaner,
    setUseDemucsCleaner,
    setMonitor,
  } = useStudio();

  const isDemo = !LIVE_CLIP_ID_RE.test(clipId);
  const [demoQuartetMode, setDemoQuartetMode] = useState<boolean>(false);
  const initialTargetId = trackMap.video?.tracks[0]?.id ?? "violin";
  const [selectedMaskId, setSelectedMaskId] = useState<string>(initialTargetId);
  const [promptInput, setPromptInput] = useState<string>("");
  const [workingStage, setWorkingStage] = useState<JobStage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const matchedTrack = trackMap.video?.tracks.find(
    (track) => track.isolation_id === selectedIsolationId,
  );
  const activeMaskId = matchedTrack?.id ?? selectedMaskId;

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
          selectedTargetId={activeMaskId}
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

      <aside className="flex w-full shrink-0 flex-col gap-4 border-t border-line bg-surface/80 p-4 backdrop-blur-md lg:w-80 lg:border-t-0 lg:border-l lg:overflow-y-auto">
        <div className="flex items-center justify-between pb-1">
          <div>
            <h2 className="text-base font-semibold tracking-tight text-text">Isolate Sound</h2>
            <p className="text-xs text-muted">Point or type to separate any stem</p>
          </div>
          <span className="mono-num rounded-full border border-line-2 bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-text-2">
            {useDemucsCleaner ? "DEMUCS" : "SAM AUDIO"}
          </span>
        </div>

        {errorMessage !== null ? (
          <div
            role="alert"
            className="rounded-card border border-accent/40 bg-accent/10 px-3.5 py-2.5 text-xs text-text shadow-xs"
          >
            {errorMessage}
          </div>
        ) : null}

        {/* Describe a sound - prominent hero prompt search */}
        <div className="space-y-3.5 rounded-card border border-line-2 bg-surface-2/40 p-3.5 shadow-xs">
          <form onSubmit={onPromptSubmit} className="space-y-2.5">
            <div className="flex items-center justify-between">
              <label htmlFor="sound-prompt-input" className="text-xs font-semibold text-text">
                Target sound
              </label>
              <span className="mono-num text-xs font-medium text-accent">
                Meta SAM Audio
              </span>
            </div>

            <div className="relative flex items-center">
              <input
                id="sound-prompt-input"
                type="text"
                value={promptInput}
                onChange={(event) => setPromptInput(event.target.value)}
                placeholder="e.g. piano, synth lead, vocals..."
                disabled={workingStage !== null}
                className="h-10 w-full rounded-card border border-line-2 bg-surface pr-20 pl-3.5 text-sm text-text placeholder:text-muted transition focus:border-accent focus:outline-none"
              />
              <button
                type="submit"
                disabled={workingStage !== null || promptInput.trim().length === 0}
                className="absolute right-1.5 h-7.5 cursor-pointer rounded-icon bg-text px-3 text-xs font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
              >
                Isolate
              </button>
            </div>

            {promptInput.trim().length > 0 ? (
              <p className="mono-num truncate px-1 text-xs text-muted">
                Prompt: &quot;{promptInput.trim()}&quot;
              </p>
            ) : null}
          </form>

          {/* Muse Spark suggestion chips */}
          {trackMap.suggestions.length > 0 ? (
            <div className="space-y-2 border-t border-line-2/60 pt-2.5">
              <span className="block text-xs font-medium text-text-2">
                Suggestions in this clip
              </span>
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
                      onClick={() => {
                        setPromptInput(chip.prompt);
                        void runOrSelectPrompt(chip.prompt, chip.label);
                      }}
                      className={`cursor-pointer rounded-full px-3 py-1 text-xs font-medium transition ${
                        active
                          ? "bg-accent font-semibold text-accent-ink shadow-xs"
                          : "border border-line-2 bg-surface text-text-2 hover:border-control hover:text-text"
                      }`}
                    >
                      {chip.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </div>

        {/* Progress Stepper */}
        {workingStage !== null ? (
          <div className="space-y-2 rounded-card border border-accent/40 bg-accent/10 p-3.5 text-xs">
            <div className="mono-num flex items-center justify-between text-xs">
              <span className="font-semibold text-accent uppercase tracking-wide">Isolating sound</span>
              <span className="h-2 w-2 rounded-full bg-accent animate-ping" />
            </div>
            <div className="mono-num flex flex-wrap items-center gap-1.5">
              {PROGRESS_STAGES.map((stage, idx) => (
                <span key={stage} className="flex items-center gap-1.5">
                  {idx > 0 ? <span className="text-muted">→</span> : null}
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs ${
                      stage === workingStage
                        ? "bg-accent font-semibold text-accent-ink shadow-xs"
                        : "text-muted"
                    }`}
                  >
                    {stage}
                  </span>
                </span>
              ))}
            </div>
            <p className="text-xs text-text-2">
              Typically ~15–20 seconds on GPU (instant if cached).
            </p>
          </div>
        ) : null}

        {/* Ready Isolated Stems */}
        {trackMap.isolations.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-semibold text-text">Isolated sounds</span>
              <span className="mono-num text-xs text-muted">
                {trackMap.isolations.length} available
              </span>
            </div>
            <div className="space-y-1.5">
              {trackMap.isolations.map((iso) => {
                const active = selectedIsolationId === iso.id;
                return (
                  <button
                    key={iso.id}
                    type="button"
                    onClick={() => {
                      selectIsolation(iso.id);
                      setMonitor("sound");
                    }}
                    className={`flex w-full cursor-pointer items-center justify-between rounded-card border px-3 py-2 text-left transition ${
                      active
                        ? "border-accent bg-surface-2 font-medium text-text shadow-xs"
                        : "border-line-2 bg-surface-2/40 text-text-2 hover:border-control hover:text-text"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {active ? <span className="h-2 w-2 shrink-0 rounded-full bg-accent" /> : null}
                        <span className="truncate text-sm font-medium">{iso.label}</span>
                      </div>
                      <span className="mono-num block truncate text-xs text-muted">
                        &quot;{iso.prompt}&quot;
                      </span>
                    </div>
                    <span className="mono-num ml-2 shrink-0 rounded-full border border-line-2 bg-bg px-2 py-0.5 text-[10px] uppercase text-muted">
                      {iso.method === "demucs" ? "Demucs" : "SAM"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {fallbackAlternative !== null ? (
          <div className="space-y-2.5 rounded-card border border-line-2 bg-surface-2/40 p-3.5 shadow-xs">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-text">Cleaner Version</span>
              <span className="mono-num rounded-full border border-line-2 bg-bg px-2 py-0.5 text-[10px] uppercase text-text-2">
                {useDemucsCleaner ? "DEMUCS ACTIVE" : "SAM AUDIO ACTIVE"}
              </span>
            </div>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={useDemucsCleaner}
                onChange={(event) => setUseDemucsCleaner(event.target.checked)}
                className="mt-0.5 h-4 w-4 rounded-xs border-line-2 accent-accent cursor-pointer"
              />
              <div className="space-y-0.5 text-xs">
                <span className="block font-medium text-text">
                  Use Demucs alternative ({fallbackAlternative.name})
                </span>
                <span className="block text-xs leading-relaxed text-text-2">
                  {fallbackComparison?.hasComparison
                    ? fallbackComparison.reason
                    : "Standard instrument found from Demucs fallback; switch to hear both versions."}
                </span>
              </div>
            </label>

            {fallbackComparison?.hasComparison &&
            fallbackComparison.samConfidence !== null &&
            fallbackComparison.demucsConfidence !== null ? (
              <div className="mono-num grid grid-cols-2 gap-2 border-t border-line-2/60 pt-2 text-xs">
                <div
                  className={`rounded-card border px-2.5 py-1 text-center ${
                    fallbackComparison.preferredMethod === "demucs"
                      ? "border-accent bg-accent/15 font-semibold text-accent"
                      : "border-line-2 bg-surface text-muted"
                  }`}
                >
                  Demucs: {Math.round(fallbackComparison.demucsConfidence * 100)}%
                </div>
                <div
                  className={`rounded-card border px-2.5 py-1 text-center ${
                    fallbackComparison.preferredMethod === "sam_audio"
                      ? "border-accent bg-accent/15 font-semibold text-accent"
                      : "border-line-2 bg-surface text-muted"
                  }`}
                >
                  SAM: {Math.round(fallbackComparison.samConfidence * 100)}%
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Demo switcher / Try precomputed demo card */}
        <div className="space-y-1.5 rounded-card border border-line-2/80 bg-surface-2/30 p-3.5">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-text">
              {isDemo ? "Upload clip" : "Reference demo"}
            </span>
            <span className="mono-num rounded-xs bg-bg/60 px-1.5 py-0.5 text-[10px] uppercase text-muted">
              {isDemo ? "Custom" : "Demo"}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-text-2">
            {isDemo
              ? "Isolate any sound in your own song or video."
              : "Compare with our precomputed reference lead."}
          </p>
          <Link
            href={isDemo ? "/" : "/c/demo1/pick"}
            className="mono-num inline-flex items-center gap-1 pt-1 text-xs font-semibold text-accent hover:underline"
          >
            {isDemo ? "+ Upload your clip →" : "Load demo1 (EDM Lead) →"}
          </Link>
        </div>

        <div className="mt-auto border-t border-line pt-3">
          {selectedIsolation !== undefined ? (
            <Link
              href={xrayHref}
              className="flex h-10 w-full items-center justify-center rounded-full bg-text text-sm font-semibold text-bg shadow-sm transition hover:opacity-90 active:scale-[0.99]"
            >
              Continue to Analyze →
            </Link>
          ) : (
            <span className="flex h-10 w-full cursor-not-allowed items-center justify-center rounded-full bg-surface-2 text-xs font-medium text-muted">
              Select a sound
            </span>
          )}
        </div>
      </aside>
    </>
  );
}
