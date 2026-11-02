import { MAX_CLIP_SECONDS } from "@/lib/audio/clip";
import {
  EngineError,
  EngineNotFoundError,
  EngineUnreachableError,
  parseEngineSession,
  parseJob,
  type EngineSession,
  type Job,
} from "./types";
import type { PixelSize, VideoArea } from "@/lib/studio/area";

const TOKEN_ROUTE = "/api/engine-token";
const TOKEN_SAFETY_SECONDS = 30;
const POLL_INTERVAL_MS = 1500;
// Eight ranked SAM Audio draws, or a Demucs fallback after them, can take about five minutes.
const POLL_TIMEOUT_MS = 600_000;
// A dropped connection or a gateway hiccup during a long wait is not the job failing.
const MAX_MISSED_POLLS = 10;
const SERVER_ERROR_STATUS = 500;
const NOT_FOUND_STATUS = 404;
const UNREACHABLE_MESSAGE = "Could not reach the engine. Check the connection and try again.";

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

export type AreaRequest = {
  jobId: string;
  area: VideoArea;
  frame: number;
};

export type StoredVideo = PixelSize & {
  fps: number;
};

export type WaitOptions = {
  onStage?: (job: Job) => void;
  signal?: AbortSignal;
};

let cached: EngineSession | null = null;

/** `fetch` rejects with a bare "Failed to fetch" when no answer arrives; say what that means. */
async function engineFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error: unknown) {
    if (init?.signal?.aborted === true) throw error;
    throw new EngineUnreachableError(UNREACHABLE_MESSAGE);
  }
}

/** The token is short-lived, so the session is renewed a little before it expires. The engine's
 *  address comes with it rather than from a public build variable. */
async function session(): Promise<EngineSession> {
  const now = Math.floor(Date.now() / 1000);
  if (cached !== null && cached.expiresAt - TOKEN_SAFETY_SECONDS > now) return cached;

  const response = await engineFetch(TOKEN_ROUTE, { method: "POST" });
  if (!response.ok) {
    throw new EngineError("Could not authorise with the engine. Try again in a moment.");
  }
  cached = parseEngineSession(await response.json());
  return cached;
}

/** FastAPI answers errors as `{"detail": "..."}`; show the sentence, not the JSON around it. */
async function errorDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "detail" in parsed) {
      if (typeof parsed.detail === "string") return parsed.detail;
    }
  } catch {
    // Not JSON: the body itself is the message.
  }
  return body;
}

async function readJob(response: Response): Promise<Job> {
  if (response.status >= SERVER_ERROR_STATUS) throw new EngineUnreachableError(UNREACHABLE_MESSAGE);
  if (!response.ok) {
    const trimmed = (await errorDetail(response)).slice(0, 200);
    if (response.status === NOT_FOUND_STATUS) throw new EngineNotFoundError(trimmed);
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
    await engineFetch(`${engineUrl}/jobs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: form,
    }),
  );
}

export async function startIsolation({ jobId, prompt, label }: IsolateRequest): Promise<Job> {
  const { token, engineUrl } = await session();
  return readJob(
    await engineFetch(`${engineUrl}/jobs/${encodeURIComponent(jobId)}/isolate`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(label === undefined ? { prompt } : { prompt, label }),
    }),
  );
}

export async function startAreaIsolation({ jobId, area, frame }: AreaRequest): Promise<Job> {
  const { token, engineUrl } = await session();
  return readJob(
    await engineFetch(`${engineUrl}/jobs/${encodeURIComponent(jobId)}/track`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ...area, frame }),
    }),
  );
}

/** The size and frame rate of the engine's stored copy, which an area is addressed in. */
export async function getStoredVideo(trackmapUrl: string): Promise<StoredVideo> {
  const response = await engineFetch(await engineFileUrl(trackmapUrl), { cache: "no-store" });
  if (!response.ok) throw new EngineError("Could not read the uploaded video.");
  const trackMap: unknown = await response.json();
  if (typeof trackMap === "object" && trackMap !== null && "video" in trackMap) {
    const video = trackMap.video;
    if (
      typeof video === "object" &&
      video !== null &&
      "width" in video &&
      "height" in video &&
      "fps" in video &&
      typeof video.width === "number" &&
      typeof video.height === "number" &&
      typeof video.fps === "number"
    ) {
      return { width: video.width, height: video.height, fps: video.fps };
    }
  }
  throw new EngineError("The uploaded clip has no video.");
}

export async function followTrack(jobId: string, trackId: string): Promise<void> {
  const { token, engineUrl } = await session();
  const path = `${encodeURIComponent(jobId)}/tracks/${encodeURIComponent(trackId)}/follow`;
  const response = await engineFetch(`${engineUrl}/jobs/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new EngineError("Could not start tracking this area.");
}

/** Following writes its result into the track's own sidecar, so that file is what gets polled. */
export async function waitForTrackFrames(masksUrl: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await engineFetch(masksUrl, { cache: "no-store" });
    if (response.ok) {
      const track: unknown = await response.json();
      if (typeof track === "object" && track !== null) {
        if ("follow_error" in track && typeof track.follow_error === "string") {
          throw new EngineError(track.follow_error);
        }
        if ("frames" in track && Array.isArray(track.frames) && track.frames.length > 0) return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new EngineError("Tracking is taking too long. Try again.");
}

const NOTES_TIMEOUT_MS = 180_000;

function hasTranscription(trackMap: unknown, isolationId: string): boolean {
  if (typeof trackMap !== "object" || trackMap === null || !("isolations" in trackMap)) return false;
  if (!Array.isArray(trackMap.isolations)) return false;
  return trackMap.isolations.some(
    (isolation: unknown) =>
      typeof isolation === "object" &&
      isolation !== null &&
      "id" in isolation &&
      isolation.id === isolationId &&
      "pitch_confidence" in isolation &&
      typeof isolation.pitch_confidence === "number",
  );
}

/**
 * A job is done when the sound is playable; its notes arrive shortly after, written by a separate
 * worker. Resolves true once they are there, false if they never come or the wait is cancelled.
 */
export async function waitForNotes(
  clipId: string,
  isolationId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + NOTES_TIMEOUT_MS;
  const url = await engineFileUrl(`clips/${encodeURIComponent(clipId)}/trackmap.json`);
  while (Date.now() < deadline && !signal.aborted) {
    try {
      const response = await engineFetch(url, { cache: "no-store", signal });
      if (response.ok && hasTranscription(await response.json(), isolationId)) return true;
    } catch {
      // A failed poll is not a failed transcription; the next one decides.
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return false;
}

export async function getJob(jobId: string): Promise<Job> {
  const { token, engineUrl } = await session();
  return readJob(
    await engineFetch(`${engineUrl}/jobs/${encodeURIComponent(jobId)}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
    }),
  );
}

/** Polls until the job finishes, reporting each stage so the UI can show progress. */
export async function waitForJob(jobId: string, options: WaitOptions = {}): Promise<Job> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStage = "";
  let missedPolls = 0;

  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) throw new EngineError("Cancelled.");
    let job: Job;
    try {
      job = await getJob(jobId);
      missedPolls = 0;
    } catch (error: unknown) {
      missedPolls += 1;
      if (!(error instanceof EngineUnreachableError) || missedPolls >= MAX_MISSED_POLLS) throw error;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      continue;
    }

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
