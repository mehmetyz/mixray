"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { JOB_STAGE_LABELS, type JobStage } from "@/lib/engine/types";
import { DEMO_CLIPS, findDemoClip, type DemoClip } from "@/lib/demos";
import { useEngineJob, type EngineJobState } from "@/lib/projects/engine-job";
import { deleteProject } from "@/lib/projects/storage";
import { separationSteps, type ProjectRecord } from "@/lib/projects/types";
import { ClipThumbnail } from "./ClipThumbnail";
import { DemoBadge } from "./DemoBadge";
import { ScreenHeading } from "./ScreenHeading";

type ProjectDashboardProps = {
  projects: readonly ProjectRecord[];
  onAddNew: () => void;
  onOpenDemo: (demo: DemoClip) => void;
};

type ProjectRowProps = {
  project: ProjectRecord;
  isConfirmingRemove: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
};

type DemoCardProps = {
  demo: DemoClip;
  onOpen: () => void;
};

type ProgressProps = {
  project: ProjectRecord;
  stage: JobStage;
};

type StatusLabelProps = {
  state: EngineJobState;
};

const WORKING_BAR_LEVELS: readonly number[] = [0.45, 0.8, 1, 0.6, 0.9, 0.5];
const CLOCK_TICK_MS = 1000;

function formatLength(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function projectFacts(project: ProjectRecord): string {
  return [
    formatLength(project.duration),
    project.bpm !== undefined ? `${project.bpm} BPM` : null,
    project.key ?? null,
    project.isolatedSoundLabel ?? project.activePrompt ?? null,
  ]
    .filter((fact): fact is string => fact !== null && fact.length > 0)
    .join(", ");
}

/** The current step, the steps around it and the real time spent: no percentage, the steps differ. */
function SeparationProgress({ project, stage }: ProgressProps) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const steps = separationSteps(project);
  const current = Math.max(0, steps.indexOf(stage));
  const elapsed = project.processingSince !== undefined ? (now - project.processingSince) / 1000 : null;

  return (
    <div className="mt-3 rounded-well border border-line-2 bg-inset px-3 py-2.5">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex h-4 items-center gap-0.5">
          {WORKING_BAR_LEVELS.map((level, index) => (
            <span
              key={index}
              style={{ height: `${level * 100}%`, animationDelay: `${index * -120}ms` }}
              className="working-bar w-0.5 rounded-full bg-accent"
            />
          ))}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text">
          {JOB_STAGE_LABELS[stage]}
        </span>
        {elapsed !== null ? (
          <span className="mono-num shrink-0 text-xs text-text-2">{formatLength(elapsed)}</span>
        ) : null}
      </div>
      <ol className="mt-2.5 flex gap-1.5" aria-label="Separation steps">
        {steps.map((stage, index) => (
          <li
            key={stage}
            aria-current={index === current ? "step" : undefined}
            className="flex-1"
            title={JOB_STAGE_LABELS[stage]}
          >
            <span
              className={`block h-1 rounded-full ${
                index < current ? "bg-text-2" : index === current ? "bg-accent" : "bg-line-2"
              }`}
            />
            <span
              className={`mt-1 block truncate text-[11px] ${
                index === current ? "text-text" : "text-muted"
              }`}
            >
              {JOB_STAGE_LABELS[stage]}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

const STATUS_LABELS: Record<EngineJobState["kind"], string> = {
  checking: "Checking",
  running: "Working",
  done: "Ready",
  failed: "Failed",
  missing: "Expired",
};

function StatusLabel({ state }: StatusLabelProps) {
  const tone =
    state.kind === "running"
      ? "border-accent/50 text-accent"
      : state.kind === "done"
        ? "border-line-2 text-text-2"
        : state.kind === "checking"
          ? "border-line text-muted"
          : "border-line-2 bg-inset text-text";
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}>
      {STATUS_LABELS[state.kind]}
    </span>
  );
}

function ProjectRow({ project, isConfirmingRemove, onAskRemove, onCancelRemove }: ProjectRowProps) {
  const href = `/c/${encodeURIComponent(project.id)}/pick`;
  const state = useEngineJob(project.id);
  const demo = findDemoClip(project.demoId);

  return (
    <li className="px-4 py-3.5">
      <div className="flex items-center gap-3">
        <ClipThumbnail clipId={project.id} kind={project.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {state.kind === "missing" ? (
              <span className="truncate text-sm font-semibold text-text-2">{project.title}</span>
            ) : (
              <Link
                href={href}
                className="truncate text-sm font-semibold text-text hover:text-accent"
              >
                {project.title}
              </Link>
            )}
            <StatusLabel state={state} />
            {demo !== undefined ? <DemoBadge origin={demo.origin} /> : null}
          </div>
          <p className="mono-num mt-1 truncate text-[11px] text-muted">
            {project.kind === "video" ? "Video" : "Audio"}, {projectFacts(project)}, added{" "}
            {new Date(project.createdAt).toLocaleDateString()}
          </p>
        </div>

        {isConfirmingRemove ? (
          <div className="flex shrink-0 items-center gap-1.5 text-xs">
            <span className="hidden text-text-2 sm:inline">Remove from this list?</span>
            <button
              type="button"
              onClick={() => deleteProject(project.id)}
              className="h-7 cursor-pointer rounded-icon bg-text px-2.5 font-semibold text-bg hover:opacity-90"
            >
              Remove
            </button>
            <button
              type="button"
              onClick={onCancelRemove}
              className="h-7 cursor-pointer rounded-icon border border-line-2 px-2.5 text-text-2 hover:text-text"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex shrink-0 items-center gap-1">
            {state.kind !== "missing" ? (
              <Link
                href={href}
                className="flex h-8 items-center rounded-icon border border-line-2 px-3 text-xs font-semibold text-text transition hover:border-control"
              >
                Open
              </Link>
            ) : null}
            <button
              type="button"
              onClick={onAskRemove}
              aria-label={`Remove ${project.title} from this list`}
              title="Remove from this list"
              className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-icon text-muted transition hover:bg-surface-2 hover:text-text"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                className="h-3.5 w-3.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {state.kind === "running" ? <SeparationProgress project={project} stage={state.stage} /> : null}
      {state.kind === "failed" ? (
        <p className="mt-2 text-xs text-text-2">
          The last separation stopped: {state.message} The sounds already separated still open.
        </p>
      ) : null}
      {state.kind === "missing" ? (
        <p className="mt-2 text-xs text-text-2">The engine deleted this clip after seven days.</p>
      ) : null}
    </li>
  );
}

function DemoCard({ demo, onOpen }: DemoCardProps) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group block w-full cursor-pointer overflow-hidden rounded-card border border-line bg-surface text-left transition hover:border-control"
      >
        <div className="relative aspect-video bg-inset">
          {/* eslint-disable-next-line @next/next/no-img-element -- a fixed local still, sized by its box */}
          <img
            src={`/demos/${demo.id}/poster.jpg`}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition group-hover:opacity-90"
          />
          <span className="absolute left-2 top-2 rounded-full bg-bg/85 backdrop-blur-xs">
            <DemoBadge origin={demo.origin} />
          </span>
        </div>
        <div className="p-3">
          <p className="truncate text-sm font-semibold text-text group-hover:text-accent">{demo.title}</p>
          <p className="mt-1 line-clamp-2 text-xs leading-snug text-text-2">{demo.shows}</p>
        </div>
      </button>
    </li>
  );
}

/** The demos that open without an upload, then the clips this browser added, newest first. */
export function ProjectDashboard({ projects, onAddNew, onOpenDemo }: ProjectDashboardProps) {
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  return (
    <div className="space-y-8">
      <div className="flex items-end justify-between gap-4">
        <ScreenHeading title="Point at a sound. Hear it alone. Learn to play it.">
          <p className="text-sm text-text-2">Open a demo, or add a song or a video of your own.</p>
        </ScreenHeading>
        <button
          type="button"
          onClick={onAddNew}
          className="h-9 shrink-0 cursor-pointer rounded-icon bg-text px-4 text-sm font-semibold text-bg transition hover:opacity-90"
        >
          New clip
        </button>
      </div>

      <details open className="group/demos rounded-card border border-line bg-surface p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block text-lg font-semibold tracking-tight text-text">Try a demo</span>
            <span className="mt-0.5 block text-sm text-text-2">
              Opens Add with the video ready: draw an area or type a sound, then continue. Each one
              says whether it is a real recording or AI-generated.
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1.5 rounded-icon border border-line-2 px-2.5 py-1.5 text-xs font-medium text-text">
            <span className="group-open/demos:hidden">Show</span>
            <span className="hidden group-open/demos:inline">Hide</span>
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="h-3.5 w-3.5 transition group-open/demos:rotate-180"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
          </span>
        </summary>
        <ul className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {DEMO_CLIPS.map((demo) => (
            <DemoCard key={demo.id} demo={demo} onOpen={() => onOpenDemo(demo)} />
          ))}
        </ul>
      </details>

      {projects.length > 0 ? (
        <section className="space-y-2.5 border-t border-line pt-6">
          <div>
            <h2 className="text-sm font-semibold text-text">Your clips</h2>
            <p className="mt-0.5 text-xs text-muted">
              Kept in this browser. The engine deletes clips after seven days.
            </p>
          </div>
      <ul className="divide-y divide-line rounded-card border border-line bg-surface">
        {projects.map((project) => (
          <ProjectRow
            key={project.id}
            project={project}
            isConfirmingRemove={confirmRemoveId === project.id}
            onAskRemove={() => setConfirmRemoveId(project.id)}
            onCancelRemove={() => setConfirmRemoveId(null)}
          />
        ))}
      </ul>
        </section>
      ) : null}
    </div>
  );
}
