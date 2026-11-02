"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { startAreaIsolation, startIsolation, waitForJob } from "@/lib/engine/client";
import { JOB_STAGE_LABELS, type Job, type JobStage } from "@/lib/engine/types";
import { useEngineJob } from "@/lib/projects/engine-job";
import { updateProject, useProject } from "@/lib/projects/storage";
import { separationSteps } from "@/lib/projects/types";
import type { VideoArea } from "@/lib/studio/area";
import { useStudio } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";
import { ClipVideo } from "./ClipVideo";
import { WorkingPanel } from "./WorkingPanel";
import { WaveformLanes } from "./WaveformLanes";
import { keyLabel } from "@/lib/studio/format";

export function PickView() {
  const router = useRouter();
  const {
    clipId,
    trackMap,
    selectedIsolation,
    selectedIsolationId,
    selectIsolation,
    setMonitor,
  } = useStudio();

  const [promptInput, setPromptInput] = useState<string>("");
  const [workingStage, setWorkingStage] = useState<JobStage | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [workingSeconds, setWorkingSeconds] = useState<number>(0);
  const [workingSteps, setWorkingSteps] = useState<readonly string[]>([]);
  const project = useProject(clipId);
  const [now, setNow] = useState<number>(() => Date.now());

  const finishSeparation = useCallback(
    (job: Job) => {
      router.refresh();
      if (job.status === "error") {
        setErrorMessage(job.error ?? "Could not isolate that sound right now.");
      } else if (job.isolationId !== null) {
        selectIsolation(job.isolationId);
        setMonitor("sound");
      }
    },
    [router, selectIsolation, setMonitor],
  );
  // A separation started on Add, or before a reload, may still be running on the engine.
  const engineJob = useEngineJob(
    clipId,
    finishSeparation,
    project?.soundIds?.length === 0 && project.processingSince !== undefined,
  );
  const resumedStage = workingStage === null && engineJob.kind === "running" ? engineJob.stage : null;
  const shownStage = workingStage ?? resumedStage;
  const shownSteps =
    resumedStage === null
      ? workingSteps
      : (project !== null ? separationSteps(project) : [resumedStage]).map((stage) => JOB_STAGE_LABELS[stage]);
  const shownSeconds =
    resumedStage !== null && project?.processingSince !== undefined
      ? Math.max(0, Math.round((now - project.processingSince) / 1000))
      : workingSeconds;
  const workingTimer = useRef<number | null>(null);

  useEffect(() => {
    if (resumedStage === null) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [resumedStage]);

  // The list shows what the clip holds; only facts are kept, never whether work is running.
  useEffect(() => {
    updateProject(clipId, {
      bpm: trackMap.tempo.confidence > 0 ? Math.round(trackMap.tempo.bpm) : undefined,
      key: trackMap.key.confidence > 0 ? keyLabel(trackMap.key) : undefined,
      isolatedSoundLabel: (selectedIsolation ?? trackMap.isolations[0])?.label,
    });
  }, [clipId, trackMap, selectedIsolation]);

  const runJob = async (firstStage: JobStage, start: () => Promise<Job>) => {
    setErrorMessage(null);
    setWorkingStage(firstStage);
    setWorkingSeconds(0);
    setWorkingSteps(
      firstStage === "naming"
        ? [JOB_STAGE_LABELS.naming, JOB_STAGE_LABELS.isolating]
        : [JOB_STAGE_LABELS.isolating],
    );
    updateProject(clipId, { processingSince: Date.now(), usesArea: firstStage === "naming" });
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

        <ClipVideo
          onSelectArea={(area: VideoArea, frame: number) => {
            void runJob("naming", () => startAreaIsolation({ jobId: clipId, area, frame }));
          }}
          areaBusy={shownStage !== null}
          sizeClass="max-w-[calc(46dvh*16/9)]"
        />

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
            disabled={shownStage !== null}
            className="h-10 w-full rounded-card border border-line-2 bg-inset pr-20 pl-3.5 text-sm text-text placeholder:text-muted focus:border-control focus:outline-none disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={shownStage !== null || promptInput.trim().length === 0}
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
                  disabled={shownStage !== null}
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

        {shownStage !== null ? (
          <WorkingPanel
            steps={shownSteps}
            current={Math.max(0, shownSteps.indexOf(JOB_STAGE_LABELS[shownStage]))}
            seconds={shownSeconds}
            note="This can take a few minutes. The mix plays meanwhile."
          />
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
