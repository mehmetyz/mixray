import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { POST } from "../app/api/coach/route";
import { COACH_UNREACHABLE_MESSAGE, parseCoachRouteReply, requestCoach } from "../lib/coach";

const BODY = {
  score: [
    {
      index: 0,
      startSeconds: 0,
      endSeconds: 2,
      attempted: true,
      hitRate: 0.5,
      onTimeRate: 0.5,
      meanOffsetMs: 12,
      missed: 1,
      extra: 0,
      wrongPitch: 1,
    },
  ],
  barCount: 1,
  notes: [{ start: 0, end: 0.5, pitch: 60, velocity: 0.7, bar: 1 }],
};

/** The page's fetch reaches the real route, and the route's fetch reaches a stubbed Muse Spark. */
function connectPageToRoute(output: readonly unknown[]): void {
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) === "/api/coach") {
      return POST(new Request("http://app.test/api/coach", { method: "POST", body: init?.body ?? null }));
    }
    return Response.json({ output });
  });
}

beforeEach(() => {
  process.env.META_API_KEY = "test-key";
});

afterEach(() => {
  mock.restoreAll();
  delete process.env.META_API_KEY;
});

describe("the Coach from the page through the route and back", () => {
  it("shows the model's words and applies its tools", async () => {
    connectPageToRoute([
      { type: "message", content: [{ type: "output_text", text: "Bar one is rushed." }] },
      { type: "function_call", name: "set_tempo", arguments: '{"percent":70}' },
    ]);
    assert.deepEqual(await requestCoach(BODY), {
      message: "Bar one is rushed.",
      actions: [{ name: "set_tempo", args: { percent: 70 } }],
    });
  });

  it("says what it did when the model called a tool and wrote nothing", async () => {
    connectPageToRoute([{ type: "function_call", name: "set_tempo", arguments: '{"percent":70}' }]);
    const reply = await requestCoach(BODY);
    assert.match(reply.message, /70/);
    assert.equal(reply.actions.length, 1);
  });

  it("shows the route's own sentence when it refuses", async () => {
    connectPageToRoute([]);
    const reply = await requestCoach({ ...BODY, barCount: 2 });
    assert.equal(reply.message, "Send valid score, bar count, and part notes.");
    assert.deepEqual(reply.actions, []);
  });

  it("says so when the route cannot be reached", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    assert.deepEqual(await requestCoach(BODY), { message: COACH_UNREACHABLE_MESSAGE, actions: [] });
  });

  it("checks actions again in case the route is a version ahead", () => {
    const reply = parseCoachRouteReply(
      {
        message: "Loop it.",
        actions: [
          { name: "set_loop", args: { start_bar: 1, end_bar: 99 } },
          { name: "set_tempo", args: { percent: 60 } },
          { name: "erase_everything", args: {} },
        ],
      },
      4,
    );
    assert.deepEqual(reply.actions, [{ name: "set_tempo", args: { percent: 60 } }]);
  });

  it("does not take a raw model reply for a route reply", () => {
    const reply = parseCoachRouteReply({ output: [] }, 4);
    assert.deepEqual(reply.actions, []);
    assert.match(reply.message, /could not be read/);
  });
});
