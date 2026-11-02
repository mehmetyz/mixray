import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { POST } from "../app/api/voice/intent/route";
import { phraseFromModelReply } from "../lib/voice-intent";

function intentRequest(body: unknown): Request {
  return new Request("http://app.test/api/voice/intent", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function toolCall(name: string, args: unknown): { output: readonly unknown[] } {
  return { output: [{ type: "function_call", name, arguments: JSON.stringify(args) }] };
}

describe("the phrase in a model reply", () => {
  it("is what run_command was given", () => {
    assert.equal(phraseFromModelReply(toolCall("run_command", { phrase: " back 2 bars " })), "back 2 bars");
  });

  it("is nothing for no_command or a broken reply", () => {
    assert.equal(phraseFromModelReply(toolCall("no_command", {})), null);
    assert.equal(phraseFromModelReply(toolCall("run_command", { phrase: "" })), null);
    assert.equal(phraseFromModelReply({ output: [{ type: "function_call", name: "run_command", arguments: "{" }] }), null);
    assert.equal(phraseFromModelReply(null), null);
  });
});

describe("the voice intent route", () => {
  beforeEach(() => {
    process.env.META_API_KEY = "test-key";
  });

  afterEach(() => {
    delete process.env.META_API_KEY;
    mock.restoreAll();
  });

  it("answers with the command the model chose", async () => {
    const fetched = mock.method(globalThis, "fetch", async () =>
      Response.json(toolCall("run_command", { phrase: "back 2 bars" })),
    );
    const response = await POST(intentRequest({ transcript: "Go back to Barth." }));
    assert.deepEqual(await response.json(), { phrase: "back 2 bars" });
    assert.equal(fetched.mock.callCount(), 1);
  });

  it("does not spend a model call on another script", async () => {
    const fetched = mock.method(globalThis, "fetch", async () => Response.json({}));
    const response = await POST(intentRequest({ transcript: "بارسفای普لейت" }));
    assert.deepEqual(await response.json(), { phrase: null });
    assert.equal(fetched.mock.callCount(), 0);
  });

  it("refuses an empty or oversized transcript", async () => {
    for (const body of ["{", {}, { transcript: "" }, { transcript: "x".repeat(201) }]) {
      assert.equal((await POST(intentRequest(body))).status, 400);
    }
  });

  it("fails with a short message when the model is unavailable", async () => {
    mock.method(globalThis, "fetch", async () => new Response("no", { status: 500 }));
    mock.method(console, "error", () => undefined);
    const response = await POST(intentRequest({ transcript: "play" }));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { phrase: null, message: "Voice is unavailable. Try again." });
  });
});
