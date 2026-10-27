import { MAX_CLIP_SECONDS } from "@/lib/audio/clip";
import { EngineError, parseEngineSession, parseJob, type EngineSession, type Job } from "./types";

const TOKEN_ROUTE = "/api/engine-token";
const TOKEN_SAFETY_SECONDS = 30;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 180_000;

export type UploadRequest = {
  blob: Blob;
  filename: string;
  clipStart: number;
  clipEnd: number;
  title?: string;
};

export type IsolateRequest = {
  jobId: string;
  prompt: string;
  label?: string;
};

export type WaitOptions = {
  onStage?: (job: Job) => void;
  signal?: AbortSignal;
};

let cached: EngineSession | null = null;

/** The token is short-lived, so the session is renewed a little before it expires. The engine's
 *  address comes with it rather than from a public build variable. */
async function session(): Promise<EngineSession> {
  const now = Math.floor(Date.now() / 1000);
  if (cached !== null && cached.expiresAt - TOKEN_SAFETY_SECONDS > now) return cached;

  const response = await fetch(TOKEN_ROUTE, { method: "POST" });
  if (!response.ok) {
    throw new EngineError("Could not authorise with the engine. Try again in a moment.");
  }
  cached = parseEngineSession(await response.json());
  return cached;
}

async function readJob(response: Response): Promise<Job> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const trimmed = detail.slice(0, 200);
    throw new EngineError(trimmed.length > 0 ? trimmed : `The engine returned ${response.status}.`);
  }
  return parseJob(await response.json());
}

/** Uploads the trimmed clip straight to the engine; Vercel caps request bodies far below this. */
export async function uploadClip({
  blob,
  filename,
  clipStart,
  clipEnd,
  title,
}: UploadRequest): Promise<Job> {
  if (clipEnd - clipStart > MAX_CLIP_SECONDS + 0.5) {
    throw new EngineError(`A clip can be at most ${MAX_CLIP_SECONDS} seconds.`);
  }

  const form = new FormData();
  form.append("file", blob, filename);
  form.append("clip_start", String(clipStart));
  form.append("clip_end", String(clipEnd));
  if (title !== undefined) form.append("title", title);

  const { token, engineUrl } = await session();
  return readJob(
    await fetch(`${engineUrl}/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }),
  );
}

export async function startIsolation({ jobId, prompt, label }: IsolateRequest): Promise<Job> {
  const { token, engineUrl } = await session();
  return readJob(
    await fetch(`${engineUrl}/jobs/${encodeURIComponent(jobId)}/isolate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(label === undefined ? { prompt } : { prompt, label }),
    }),
  );
}

export async function getJob(jobId: string): Promise<Job> {
  const { token, engineUrl } = await session();
  return readJob(
    await fetch(`${engineUrl}/jobs/${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
  );
}

/** Polls until the job finishes, reporting each stage so the UI can show progress. */
export async function waitForJob(jobId: string, options: WaitOptions = {}): Promise<Job> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStage = "";

  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new EngineError("Cancelled.");
    const job = await getJob(jobId);

    if (job.stage !== lastStage) {
      lastStage = job.stage;
      options.onStage?.(job);
    }
    if (job.status === "error") {
      throw new EngineError(job.error ?? "The engine could not finish that clip.");
    }
    if (job.status === "done") return job;

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new EngineError("The engine is taking too long. Try again.");
}

/** Turns a path the engine reported into a URL the browser can load. */
export async function engineFileUrl(path: string): Promise<string> {
  const { engineUrl } = await session();
  const clean = path.replace(/^\//, "");
  return clean.startsWith("files/") ? `${engineUrl}/${clean}` : `${engineUrl}/files/${clean}`;
}
