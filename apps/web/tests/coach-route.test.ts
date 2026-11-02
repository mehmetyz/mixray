import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { POST } from "../app/api/coach/route";

const BAR = {
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
};
const NOTE = { start: 0, end: 0.5, pitch: 60, velocity: 0.7, bar: 1 };
const GOOD_BODY = { score: [BAR], barCount: 1, notes: [NOTE] };

function coachRequest(body: unknown): Request {
  return new Request("http://app.test/api/coach", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function modelReply(output: readonly unknown[]): Response {
  return Response.json({ output });
}

function messageItem(text: string): unknown {
  return { type: "message", content: [{ type: "output_text", text }] };
}

function toolCall(name: string, args: unknown): unknown {
  return { type: "function_call", name, arguments: JSON.stringify(args) };
}

beforeEach(() => {
  process.env.META_API_KEY = "test-key";
});

afterEach(() => {
  mock.restoreAll();
  delete process.env.META_API_KEY;
});

describe("what the Coach route accepts", () => {
  for (const [name, body] of [
    ["text that is not JSON", "not json"],
    ["no score", { barCount: 1, notes: [] }],
    ["a score of the wrong length", { ...GOOD_BODY, barCount: 2 }],
    ["a bar outside the piece", { ...GOOD_BODY, score: [{ ...BAR, index: 3 }] }],
    ["a rate above one", { ...GOOD_BODY, score: [{ ...BAR, hitRate: 1.5 }] }],
    ["a MIDI velocity where 0 to 1 is expected", { ...GOOD_BODY, notes: [{ ...NOTE, velocity: 90 }] }],
    ["a zero-based bar on a note", { ...GOOD_BODY, notes: [{ ...NOTE, bar: 0 }] }],
    ["a pitch outside MIDI", { ...GOOD_BODY, notes: [{ ...NOTE, pitch: 128 }] }],
    ["too many bars", { ...GOOD_BODY, barCount: 129 }],
  ] as const) {
    it(`refuses ${name} without calling the model`, async () => {
      const fetchMock = mock.method(globalThis, "fetch", async () => modelReply([]));
      const response = await POST(coachRequest(body));
      assert.equal(response.status, 400);
      const reply: unknown = await response.json();
      assert.ok(typeof reply === "object" && reply !== null && "actions" in reply);
      assert.deepEqual(reply.actions, []);
      assert.equal(fetchMock.mock.callCount(), 0);
    });
  }
});

describe("what the Coach route answers", () => {
  it("sends the score and never the key to the browser", async () => {
    const fetchMock = mock.method(globalThis, "fetch", async () => modelReply([messageItem("Slow down.")]));
    const response = await POST(coachRequest(GOOD_BODY));
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes("test-key"));

    const call = fetchMock.mock.calls[0];
    const init: unknown = call?.arguments[1];
    assert.ok(typeof init === "object" && init !== null && "body" in init);
    const sent: unknown = JSON.parse(String(init.body));
    assert.ok(typeof sent === "object" && sent !== null && "tools" in sent && Array.isArray(sent.tools));
    const tools: unknown[] = sent.tools.map((tool: unknown) =>
      typeof tool === "object" && tool !== null && "name" in tool ? tool.name : null,
    );
    assert.deepEqual(tools, ["set_loop", "set_tempo", "switch_hand", "simplify_bar", "mark_problem_bar"]);
  });

  it("returns the words and the tool calls that are valid", async () => {
    mock.method(globalThis, "fetch", async () =>
      modelReply([messageItem("Bar one is rushed."), toolCall("set_tempo", { percent: 70 })]),
    );
    const reply: unknown = await (await POST(coachRequest(GOOD_BODY))).json();
    assert.deepEqual(reply, {
      message: "Bar one is rushed.",
      actions: [{ name: "set_tempo", args: { percent: 70 } }],
    });
  });

  it("drops a tool call that leaves the piece, instead of applying it", async () => {
    mock.method(globalThis, "fetch", async () =>
      modelReply([
        messageItem("Loop it."),
        toolCall("set_loop", { start_bar: 5, end_bar: 9 }),
        toolCall("erase_everything", {}),
      ]),
    );
    const reply: unknown = await (await POST(coachRequest(GOOD_BODY))).json();
    assert.ok(typeof reply === "object" && reply !== null && "actions" in reply);
    assert.deepEqual(reply.actions, []);
  });

  it("says so when it is not configured", async () => {
    delete process.env.META_API_KEY;
    const response = await POST(coachRequest(GOOD_BODY));
    assert.equal(response.status, 503);
  });

  it("answers 502 when the model is down or unreadable", async () => {
    mock.method(globalThis, "fetch", async () => new Response("", { status: 500 }));
    assert.equal((await POST(coachRequest(GOOD_BODY))).status, 502);
    mock.restoreAll();

    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("network");
    });
    assert.equal((await POST(coachRequest(GOOD_BODY))).status, 502);
    mock.restoreAll();

    mock.method(globalThis, "fetch", async () => new Response("<html>", { status: 200 }));
    assert.equal((await POST(coachRequest(GOOD_BODY))).status, 502);
  });
});
