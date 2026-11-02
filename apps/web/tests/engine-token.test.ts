import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { POST } from "../app/api/engine-token/route";

const SECRET = "mixray-test-secret";
// The same pair is asserted in engine/tests/test_web_api.py, so the token the web mints and the token
// the engine accepts cannot drift apart unnoticed.
const EXPIRY = 4_102_444_800;
const SIGNATURE = "7f0b07530d8d8e616d9d75632daf97348c74b7a0fef496a2836962a203531d15";
const TTL_SECONDS = 600;

afterEach(() => {
  mock.restoreAll();
  delete process.env.MIXRAY_API_KEY;
  delete process.env.MIXRAY_ENGINE_URL;
});

describe("the engine token route", () => {
  it("signs the expiry the way the engine checks it", async () => {
    process.env.MIXRAY_API_KEY = SECRET;
    process.env.MIXRAY_ENGINE_URL = "https://engine.test/";
    mock.method(Date, "now", () => (EXPIRY - TTL_SECONDS) * 1000);

    const response = await POST();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      token: `${EXPIRY}.${SIGNATURE}`,
      expiresAt: EXPIRY,
      engineUrl: "https://engine.test",
    });
  });

  it("never sends the key itself to the browser", async () => {
    process.env.MIXRAY_API_KEY = SECRET;
    process.env.MIXRAY_ENGINE_URL = "https://engine.test";
    assert.ok(!(await (await POST()).text()).includes(SECRET));
  });

  it("says what is missing when it is not configured", async () => {
    process.env.MIXRAY_ENGINE_URL = "https://engine.test";
    const noKey = await POST();
    assert.equal(noKey.status, 503);
    assert.deepEqual(await noKey.json(), { error: "The engine key is not configured." });

    delete process.env.MIXRAY_ENGINE_URL;
    process.env.MIXRAY_API_KEY = SECRET;
    const noAddress = await POST();
    assert.equal(noAddress.status, 503);
    assert.deepEqual(await noAddress.json(), { error: "The engine address is not configured." });
  });
});
