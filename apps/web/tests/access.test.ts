import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { NextRequest } from "next/server";
import { POST } from "../app/api/access/route";
import { proxy } from "../proxy";
import { ACCESS_COOKIE, accessToken, hasAccess, keyMatches, safeNextPath } from "../lib/access";
import { demoVideoSource } from "../lib/landing/demo-video";

const KEY = "judge-key";
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function setNodeEnv(value: string | undefined): void {
  Reflect.set(process.env, "NODE_ENV", value);
}

afterEach(() => {
  delete process.env.MIXRAY_ACCESS_KEY;
  setNodeEnv(ORIGINAL_NODE_ENV);
});

function request(body: unknown): Request {
  return new Request("http://app.test/api/access", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("the access key", () => {
  it("opens with the right key, ignoring spaces around it", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    assert.equal(await keyMatches(KEY), true);
    assert.equal(await keyMatches(`  ${KEY} `), true);
    assert.equal(await keyMatches("wrong"), false);
  });

  it("accepts only the cookie that key signs", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    assert.equal(await hasAccess(await accessToken(KEY)), true);
    assert.equal(await hasAccess(await accessToken("wrong")), false);
    assert.equal(await hasAccess(KEY), false);
    assert.equal(await hasAccess(undefined), false);
  });

  it("stays closed in development and in production when no key is set", async () => {
    for (const environment of ["development", "production"]) {
      setNodeEnv(environment);
      assert.equal(await hasAccess(undefined), false);
      assert.equal(await hasAccess(await accessToken("anything")), false);
      assert.equal(await keyMatches("anything"), false);
    }
  });
});

describe("a link with the key", () => {
  const visit = (path: string) => proxy(new NextRequest(`http://app.test${path}`));

  it("stays on the landing page, sets the cookie and leaves the key out of the address", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    const response = await visit(`/?key=${KEY}`);
    assert.equal(response.status, 307);
    assert.equal(response.headers.get("location"), "http://app.test/");
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.ok(cookie.startsWith(`${ACCESS_COOKIE}=${await accessToken(KEY)};`));
    assert.ok(!cookie.includes(KEY));
  });

  it("keeps the page asked for, for the button on the landing page", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    const response = await visit(`/?key=${KEY}&next=${encodeURIComponent("/studio/new")}`);
    assert.equal(response.headers.get("location"), "http://app.test/?next=%2Fstudio%2Fnew");
  });

  it("stays on the landing page with a wrong key, or with none set", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    const wrong = await visit("/?key=wrong");
    assert.equal(wrong.headers.get("location"), null);
    assert.equal(wrong.headers.get("set-cookie"), null);
    delete process.env.MIXRAY_ACCESS_KEY;
    assert.equal((await visit(`/?key=${KEY}`)).headers.get("set-cookie"), null);
  });

  it("does not open the studio or the model routes when the key is put on them", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    assert.equal((await visit(`/studio?key=${KEY}`)).headers.get("location")?.startsWith("http://app.test/?next="), true);
    assert.equal((await visit(`/api/coach?key=${KEY}`)).status, 401);
    assert.equal((await visit("/api/voice/intent")).status, 401);
  });
});

describe("the access route", () => {
  it("sets a cookie that holds a signature, never the key", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    const response = await POST(request({ key: KEY }));
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie") ?? "";
    assert.ok(cookie.startsWith(`${ACCESS_COOKIE}=${await accessToken(KEY)};`));
    assert.ok(cookie.includes("HttpOnly"));
    assert.ok(!cookie.includes(KEY));
  });

  it("refuses a wrong key and sets nothing", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    const response = await POST(request({ key: "wrong" }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
  });

  it("asks for a key when there is none", async () => {
    process.env.MIXRAY_ACCESS_KEY = KEY;
    assert.equal((await POST(request({ key: "  " }))).status, 400);
    assert.equal((await POST(request("not json"))).status, 400);
    assert.equal((await POST(request({ key: 3 }))).status, 400);
  });
});

describe("where entering leads", () => {
  it("keeps paths inside the site", () => {
    assert.equal(safeNextPath("/c/abc/pick?iso=1"), "/c/abc/pick?iso=1");
    assert.equal(safeNextPath(undefined), "/studio");
  });

  it("refuses links that leave the site", () => {
    for (const next of ["https://evil.test", "//evil.test", "/\\evil.test", "evil"]) {
      assert.equal(safeNextPath(next), "/studio", next);
    }
  });
});

describe("the demo video", () => {
  it("is left out until a video is set", () => {
    assert.equal(demoVideoSource(undefined), null);
    assert.equal(demoVideoSource("  "), null);
    assert.equal(demoVideoSource("http://insecure.test/a.mp4"), null);
  });

  it("embeds YouTube links without tracking cookies, and plays files directly", () => {
    const embed = "https://www.youtube-nocookie.com/embed/abc123XYZ";
    assert.deepEqual(demoVideoSource("https://youtu.be/abc123XYZ"), { kind: "embed", url: embed });
    assert.deepEqual(demoVideoSource("https://www.youtube.com/watch?v=abc123XYZ&t=3"), { kind: "embed", url: embed });
    assert.deepEqual(demoVideoSource("https://cdn.test/demo.mp4"), { kind: "file", url: "https://cdn.test/demo.mp4" });
  });
});
