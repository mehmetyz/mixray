import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { getJob, waitForJob, engineFileUrl, startIsolation } from "../lib/engine/client";
import {
  EngineError,
  EngineNotFoundError,
  EngineUnreachableError,
  parseEngineSession,
  parseJob,
  type Job,
} from "../lib/engine/types";

type Reply = Response | Error;

const SESSION = { token: "t.s", expiresAt: 4_102_444_800, engineUrl: "https://engine.test" };

function job(stage: string, status: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ id: "clip", status, stage, trackmap_url: "/t.json", ...extra });
}

/** Answers the token route, then gives the engine's replies in order; the last one repeats. */
function engineReplies(replies: readonly Reply[]): string[] {
  const asked: string[] = [];
  let next = 0;
  mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const url = String(input);
    if (url === "/api/engine-token") return Response.json(SESSION);
    asked.push(url);
    const reply = replies[Math.min(next, replies.length - 1)];
    next += 1;
    if (reply === undefined) throw new Error("no reply set");
    if (reply instanceof Error) throw reply;
    return reply.clone();
  });
  return asked;
}

beforeEach(() => {
  mock.method(globalThis, "setTimeout", (callback: () => void) => {
    queueMicrotask(callback);
    return 0;
  });
});

afterEach(() => mock.restoreAll());

describe("reading a job", () => {
  it("reads what the engine sends", async () => {
    const asked = engineReplies([
      job("isolating", "running", { isolation_id: "iso", cached: true, error: "" }),
    ]);
    const read: Job = await getJob("a b");
    assert.equal(asked[0], "https://engine.test/jobs/a%20b");
    assert.deepEqual(read, {
      id: "clip",
      status: "running",
      stage: "isolating",
      trackmapUrl: "/t.json",
      isolationId: "iso",
      cached: true,
      error: null,
    });
  });

  it("calls a dropped connection what it is, not 'Failed to fetch'", async () => {
    engineReplies([new TypeError("Failed to fetch")]);
    await assert.rejects(getJob("clip"), (error: unknown) => {
      assert.ok(error instanceof EngineUnreachableError);
      assert.match(error.message, /Could not reach the engine/);
      return true;
    });
  });

  it("treats a gateway error as unreachable, whatever its body says", async () => {
    engineReplies([new Response("<html>bad gateway</html>", { status: 502 })]);
    await assert.rejects(getJob("clip"), EngineUnreachableError);
  });

  it("knows a clip that is gone", async () => {
    engineReplies([Response.json({ detail: "Job not found." }, { status: 404 })]);
    await assert.rejects(getJob("clip"), (error: unknown) => {
      assert.ok(error instanceof EngineNotFoundError);
      assert.equal(error.message, "Job not found.");
      return true;
    });
  });

  it("shows the engine's sentence and not the JSON around it", async () => {
    engineReplies([Response.json({ detail: "Daily clips limit (25) reached." }, { status: 429 })]);
    await assert.rejects(getJob("clip"), { message: "Daily clips limit (25) reached." });
  });

  it("says something even when an error has no body", async () => {
    engineReplies([new Response("", { status: 403 })]);
    await assert.rejects(getJob("clip"), { message: "The engine returned 403." });
  });
});

describe("waiting for a job", () => {
  it("reports each stage once and returns when done", async () => {
    engineReplies([
      job("naming", "running"),
      job("naming", "running"),
      job("isolating", "running"),
      job("done", "done"),
    ]);
    const stages: string[] = [];
    const finished = await waitForJob("clip", { onStage: (seen) => stages.push(seen.stage) });
    assert.equal(finished.status, "done");
    assert.deepEqual(stages, ["naming", "isolating", "done"]);
  });

  it("does not fail a long separation over dropped polls", async () => {
    engineReplies([
      job("isolating", "running"),
      new TypeError("Failed to fetch"),
      new Response("", { status: 503 }),
      new TypeError("Failed to fetch"),
      job("done", "done"),
    ]);
    assert.equal((await waitForJob("clip")).status, "done");
  });

  it("gives up when the engine stays away", async () => {
    const asked = engineReplies([new TypeError("Failed to fetch")]);
    await assert.rejects(waitForJob("clip"), EngineUnreachableError);
    assert.equal(asked.length, 10);
  });

  it("counts only misses in a row", async () => {
    const miss = new TypeError("Failed to fetch");
    const running = job("isolating", "running");
    engineReplies([...Array<Reply>(9).fill(miss), running, ...Array<Reply>(9).fill(miss), job("done", "done")]);
    assert.equal((await waitForJob("clip")).status, "done");
  });

  it("does not retry a clip that does not exist", async () => {
    const asked = engineReplies([Response.json({ detail: "Job not found." }, { status: 404 })]);
    await assert.rejects(waitForJob("clip"), EngineNotFoundError);
    assert.equal(asked.length, 1);
  });

  it("passes on the engine's reason when the job fails", async () => {
    engineReplies([job("error", "error", { error: "That sound was not found." })]);
    await assert.rejects(waitForJob("clip"), { message: "That sound was not found." });
  });

  it("has a reason when the engine gave none", async () => {
    engineReplies([job("error", "error")]);
    await assert.rejects(waitForJob("clip"), { message: "The engine could not finish that clip." });
  });

  it("stops when cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(waitForJob("clip", { signal: controller.signal }), { message: "Cancelled." });
  });
});

describe("requests", () => {
  it("sends the token and the sound to separate", async () => {
    let sent: RequestInit | undefined;
    mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "/api/engine-token") return Response.json(SESSION);
      sent = init;
      return job("isolating", "running");
    });
    await startIsolation({ jobId: "clip", prompt: "piano", label: "Piano" });
    assert.equal(sent?.method, "POST");
    assert.deepEqual(JSON.parse(String(sent?.body)), { prompt: "piano", label: "Piano" });
    assert.equal(new Headers(sent?.headers).get("authorization"), "Bearer t.s");
  });

  it("builds file addresses however the path was written", async () => {
    engineReplies([job("done", "done")]);
    assert.equal(await engineFileUrl("/files/clips/a/mix.mp3"), "https://engine.test/files/clips/a/mix.mp3");
    assert.equal(await engineFileUrl("clips/a/mix.mp3"), "https://engine.test/files/clips/a/mix.mp3");
  });
});

describe("validating engine replies", () => {
  const good = { id: "a", status: "running", stage: "isolating", trackmap_url: "/t" };

  for (const [name, value, message] of [
    ["not an object", 3, /could not read/],
    ["no id", { ...good, id: "" }, /no id/],
    ["an unknown status", { ...good, status: "paused" }, /unknown job status: paused/],
    ["an unknown stage", { ...good, stage: "dreaming" }, /unknown job stage: dreaming/],
  ] as const) {
    it(`refuses ${name}`, () => {
      assert.throws(() => parseJob(value), (error: unknown) => {
        assert.ok(error instanceof EngineError);
        assert.match(error.message, message);
        return true;
      });
    });
  }

  it("refuses a session it cannot use", () => {
    assert.throws(() => parseEngineSession(null), EngineError);
    assert.throws(() => parseEngineSession({ ...SESSION, token: "" }), /empty/);
    assert.throws(() => parseEngineSession({ ...SESSION, expiresAt: "soon" }), /expiry/);
    assert.throws(() => parseEngineSession({ ...SESSION, engineUrl: "" }), /address/);
  });
});
