"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { startAreaIsolation, startIsolation, waitForJob } from "@/lib/engine/client";
import type { Job, JobStage } from "@/lib/engine/types";
import type { VideoArea } from "@/lib/studio/area";
import { useStudio } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";
import { VideoMaskStage } from "./VideoMaskStage";
import { WorkingPanel } from "./WorkingPanel";
import { WaveformLanes } from "./WaveformLanes";

const STAGE_LABELS: Record<JobStage, string> = {
  listening: "Listening to the clip",
  segmenting: "Finding the area",
  naming: "Naming the area",
  isolating: "Separating the sound",
  analyzing: "Reading the notes",
  done: "Finishing",
  error: "Stopped",
};

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

  const [promptInput, setPromptInput] = useState<string>("");
  const [workingStage, setWorkingStage] = useState<JobStage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [workingSeconds, setWorkingSeconds] = useState<number>(0);
  const [workingSteps, setWorkingSteps] = useState<readonly string[]>([]);
  const workingTimer = useRef<number | null>(null);

  const runJob = async (firstStage: JobStage, start: () => Promise<Job>) => {
    setErrorMessage(null);
    setWorkingStage(firstStage);
    setWorkingSeconds(0);
    setWorkingSteps(
      firstStage === "naming"
        ? [STAGE_LABELS.naming, STAGE_LABELS.isolating]
        : [STAGE_LABELS.isolating],
    );
    workingTimer.current = window.setInterval(() => setWorkingSeconds((seconds) => seconds + 1), 1000);
    try {
      const initialJob = await start();
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
      if (workingTimer.current !== null) window.clearInterval(workingTimer.current);
      setWorkingStage(null);
    }
  };

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

    await runJob("isolating", () =>
      startIsolation({ jobId: clipId, prompt: cleanPrompt, label }),
    );
  };

  const onPromptSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void runOrSelectPrompt(promptInput);
  };

  const xrayHref =
    selectedIsolationId.length > 0
      ? `/c/${encodeURIComponent(clipId)}/xray?iso=${encodeURIComponent(selectedIsolationId)}`
      : `/c/${encodeURIComponent(clipId)}/xray`;

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-bg lg:overflow-y-auto">
        <TimelineRuler />

        {trackMap.video !== undefined ? (
          <VideoMaskStage
            video={trackMap.video}
            onSelectArea={(area: VideoArea, frame: number) => {
              void runJob("naming", () => startAreaIsolation({ jobId: clipId, area, frame }));
            }}
            areaBusy={workingStage !== null}
            sizeClass="max-w-[calc(46dvh*16/9)]"
          />
        ) : null}

        <WaveformLanes />
      </section>

      <aside className="flex w-full shrink-0 flex-col gap-5 border-t border-line bg-surface/80 p-4 lg:w-80 lg:overflow-y-auto lg:border-t-0 lg:border-l">
        <h2 className="text-base font-semibold tracking-tight text-text">Pick a sound</h2>

        {errorMessage !== null ? (
          <div
            role="alert"
            className="rounded-card border border-accent/40 bg-accent/10 px-3.5 py-2.5 text-sm text-text"
          >
            {errorMessage}
          </div>
        ) : null}

        <form onSubmit={onPromptSubmit} className="relative flex items-center">
          <label htmlFor="sound-prompt-input" className="sr-only">
            Sound to isolate
          </label>
          <input
            id="sound-prompt-input"
            type="text"
            value={promptInput}
            onChange={(event) => setPromptInput(event.target.value)}
            placeholder="Piano, vocals, bass…"
            disabled={workingStage !== null}
            className="h-10 w-full rounded-card border border-line-2 bg-inset pr-20 pl-3.5 text-sm text-text placeholder:text-muted focus:border-control focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={workingStage !== null || promptInput.trim().length === 0}
            className="absolute right-1.5 h-7.5 cursor-pointer rounded-icon bg-text px-3 text-xs font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Isolate
          </button>
        </form>

        {trackMap.suggestions.length > 0 ? (
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
                  className={`cursor-pointer rounded-full px-3 py-1 text-sm transition disabled:opacity-50 ${
                    active
                      ? "bg-accent font-medium text-accent-ink"
                      : "border border-line-2 text-text-2 hover:border-control hover:text-text"
                  }`}
                >
                  {chip.label}
                </button>
              );
            })}
          </div>
        ) : null}

        {workingStage !== null ? (
          <WorkingPanel
            steps={workingSteps}
            current={Math.max(0, workingSteps.indexOf(STAGE_LABELS[workingStage]))}
            seconds={workingSeconds}
            note="Separating a sound can take a few minutes."
          />
        ) : null}

        {fallbackAlternative !== null ? (
          <label className="flex cursor-pointer items-start gap-2.5 border-t border-line pt-4 text-sm">
            <input
              type="checkbox"
              checked={useDemucsCleaner}
              onChange={(event) => setUseDemucsCleaner(event.target.checked)}
              className="mt-0.5 h-4 w-4 cursor-pointer rounded-xs border-line-2 accent-accent"
            />
            <span>
              <span className="block text-text">Hear the Demucs version</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                For comparison here. The next screens keep the selected sound and its notes.
              </span>
            </span>
          </label>
        ) : null}

        <div className="mt-auto pt-3">
          {selectedIsolation !== undefined ? (
            <Link
              href={xrayHref}
              className="flex h-10 w-full items-center justify-center rounded-full bg-text text-sm font-semibold text-bg transition hover:opacity-90"
            >
              Continue to Analyze
            </Link>
          ) : null}
        </div>
      </aside>
    </>
  );
}
