export const JOB_STATUSES = ["queued", "running", "done", "error"] as const;
// "naming" is the area flow: Muse Spark names the drawn area, and only then does the separation
// start. "segmenting" remains in jobs written before it. A stage the client does not know throws.
export const JOB_STAGES = [
  "listening",
  "segmenting",
  "naming",
  "isolating",
  "analyzing",
  "done",
  "error",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type JobStage = (typeof JOB_STAGES)[number];

export const JOB_STAGE_LABELS: Record<JobStage, string> = {
  listening: "Listening to the clip",
  segmenting: "Finding the area",
  naming: "Naming the area",
  isolating: "Separating the sound",
  analyzing: "Reading the notes",
  done: "Finishing",
  error: "Stopped",
};

/** What every engine endpoint returns. Mirrors `JobResponse` in `engine/web.py`. */
export type Job = {
  id: string;
  status: JobStatus;
  stage: JobStage;
  trackmapUrl: string;
  isolationId: string | null;
  cached: boolean;
  error: string | null;
};

/** A short-lived pass to the engine: what to send, where to send it, and until when. */
export type EngineSession = {
  token: string;
  expiresAt: number;
  engineUrl: string;
};

export class EngineError extends Error {
  override name = "EngineError";
}

/** The engine has no such clip: never uploaded, or deleted after seven days. */
export class EngineNotFoundError extends EngineError {
  override name = "EngineNotFoundError";
}

/** No answer, or a gateway error with no body: worth asking again before giving up. */
export class EngineUnreachableError extends EngineError {
  override name = "EngineUnreachableError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isJobStatus(value: unknown): value is JobStatus {
  return JOB_STATUSES.some((known) => known === value);
}

function isJobStage(value: unknown): value is JobStage {
  return JOB_STAGES.some((known) => known === value);
}

/** Validates at the boundary: the engine is a separate deployment and may be a version behind. */
export function parseJob(value: unknown): Job {
  if (!isRecord(value)) throw new EngineError("The engine sent a reply we could not read.");

  const { id, status, stage, trackmap_url: trackmapUrl } = value;
  if (typeof id !== "string" || id.length === 0) {
    throw new EngineError("The engine sent a job with no id.");
  }
  if (!isJobStatus(status)) {
    throw new EngineError(`The engine sent an unknown job status: ${String(status)}`);
  }
  if (!isJobStage(stage)) {
    throw new EngineError(`The engine sent an unknown job stage: ${String(stage)}`);
  }

  return {
    id,
    status,
    stage,
    trackmapUrl: typeof trackmapUrl === "string" ? trackmapUrl : "",
    isolationId: asOptionalString(value.isolation_id),
    cached: value.cached === true,
    error: asOptionalString(value.error),
  };
}

export function parseEngineSession(value: unknown): EngineSession {
  if (!isRecord(value)) throw new EngineError("Could not read the engine token.");
  const { token, expiresAt, engineUrl } = value;
  if (typeof token !== "string" || token.length === 0) {
    throw new EngineError("The engine token was empty.");
  }
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
    throw new EngineError("The engine token had no expiry.");
  }
  if (typeof engineUrl !== "string" || engineUrl.length === 0) {
    throw new EngineError("The engine address was missing.");
  }
  return { token, expiresAt, engineUrl };
}
