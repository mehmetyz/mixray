import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { DEMO_CLIPS, DEMO_CLIP_IDS, DEMO_ORIGIN_LABELS, findDemoClip } from "../lib/demos";

const CREDITS = readFileSync(new URL("../../../CREDITS.md", import.meta.url), "utf8");
const MAX_DEMO_BYTES = 50 * 1024 * 1024;

function demoFile(id: string, name: string): URL {
  return new URL(`../public/demos/${id}/${name}`, import.meta.url);
}

describe("demo clips", () => {
  it("lists every id once", () => {
    assert.deepEqual(DEMO_CLIPS.map((demo) => demo.id).sort(), [...DEMO_CLIP_IDS].sort());
  });

  for (const demo of DEMO_CLIPS) {
    describe(demo.id, () => {
      it("has its video and still in the app, under the upload limit", () => {
        assert.ok(existsSync(demoFile(demo.id, "video.mp4")));
        assert.ok(existsSync(demoFile(demo.id, "poster.jpg")));
        assert.ok(statSync(demoFile(demo.id, "video.mp4")).size < MAX_DEMO_BYTES);
      });

      it("is credited with its origin, because every file on screen must be", () => {
        const row = CREDITS.split("\n").find((line) => line.includes(`\`${demo.id}\``));
        assert.ok(row !== undefined, "no row in CREDITS.md");
        assert.ok(row.includes(DEMO_ORIGIN_LABELS[demo.origin]));
      });

      it("has a sound typed in and says what it shows", () => {
        assert.ok(demo.prompt.length > 0);
        assert.ok(demo.shows.length > 0);
        assert.ok(demo.credit.length > 0);
      });

      if (demo.origin === "real") {
        it("links to where the real recording came from", () => {
          assert.ok(demo.sourceUrl?.startsWith("https://"));
          assert.ok(CREDITS.includes(demo.sourceUrl ?? ""));
        });
      }
    });
  }

  it("finds a demo by id and nothing for anything else", () => {
    assert.equal(findDemoClip("cafe-piano")?.title, "Piano and espresso steam");
    assert.equal(findDemoClip("absent"), undefined);
    assert.equal(findDemoClip(undefined), undefined);
  });
});
