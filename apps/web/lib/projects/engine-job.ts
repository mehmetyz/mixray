"use client";

import { useEffect, useRef, useState } from "react";
import { getJob } from "@/lib/engine/client";
import { EngineNotFoundError, EngineUnreachableError, type Job, type JobStage } from "@/lib/engine/types";

export type EngineJobState =
  | { kind: "checking" }
  | { kind: "running"; stage: JobStage }
  | { kind: "done" }
  | { kind: "failed"; message: string }
  | { kind: "missing" };

const POLL_INTERVAL_MS = 2000;
const MAX_MISSED_POLLS = 10;

function isRunning(job: Job): boolean {
  return job.status === "running" || job.status === "queued";
}

function stateOf(job: Job): EngineJobState {
  if (isRunning(job)) return { kind: "running", stage: job.stage };
  if (job.status === "error") return { kind: "failed", message: job.error ?? "The last separation stopped." };
  return { kind: "done" };
}

/**
 * What the engine says about a clip's work, asked again every two seconds while it runs. The engine
 * is the only record of it: copies kept in the browser went stale and contradicted each other.
 * `onFinished` fires when work seen running ends, so a page can load what it produced.
 */
export function useEngineJob(jobId: string, onFinished?: (job: Job) => void): EngineJobState {
  const [state, setState] = useState<EngineJobState>({ kind: "checking" });
  const onFinishedRef = useRef(onFinished);
  useEffect(() => {
    onFinishedRef.current = onFinished;
  }, [onFinished]);

  useEffect(() => {
    let cancelled = false;
    const wait = () => new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

    const poll = async () => {
      let missed = 0;
      let sawRunning = false;
      while (!cancelled) {
        let job: Job;
        try {
          job = await getJob(jobId);
          missed = 0;
        } catch (error: unknown) {
          if (cancelled) return;
          if (error instanceof EngineNotFoundError) {
            setState({ kind: "missing" });
            return;
          }
          missed += 1;
          if (error instanceof EngineUnreachableError && missed < MAX_MISSED_POLLS) {
            await wait();
            continue;
          }
          setState({ kind: "failed", message: error instanceof Error ? error.message : "The engine did not answer." });
          return;
        }
        if (cancelled) return;
        setState(stateOf(job));
        if (isRunning(job)) {
          sawRunning = true;
          await wait();
          continue;
        }
        if (sawRunning) onFinishedRef.current?.(job);
        return;
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  return state;
}
