import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { InvalidTrackMapError, parseTrackMap } from "../lib/trackmap/validate";

type JsonRecord = Record<string, unknown>;

function validTrackMap(): JsonRecord {
  const parsed: JsonRecord = JSON.parse(
    readFileSync(new URL("../public/demos/demo1/trackmap.json", import.meta.url), "utf8"),
  );
  return parsed;
}

describe("the contract with the engine", () => {
  it("accepts a complete TrackMap", () => {
    assert.equal(parseTrackMap(validTrackMap()).version, 2);
  });

  it("accepts a clip with no sounds yet", () => {
    assert.deepEqual(parseTrackMap({ ...validTrackMap(), suggestions: [], isolations: [] }).isolations, []);
  });

  for (const field of ["id", "source", "duration", "tempo", "beats", "key", "isolations"]) {
    it(`refuses a TrackMap without ${field}`, () => {
      const broken = validTrackMap();
      delete broken[field];
      assert.throws(() => parseTrackMap(broken), InvalidTrackMapError);
    });
  }

  it("refuses another schema version", () => {
    assert.throws(() => parseTrackMap({ ...validTrackMap(), version: 1 }), InvalidTrackMapError);
  });

  it("refuses a field it does not know, so drift is caught at the boundary", () => {
    assert.throws(() => parseTrackMap({ ...validTrackMap(), extra: true }), InvalidTrackMapError);
  });

  it("names what was wrong", () => {
    assert.throws(() => parseTrackMap({ ...validTrackMap(), duration: "long" }), /duration/);
  });

  it("refuses things that are not a TrackMap at all", () => {
    for (const value of [null, 3, "text", []]) {
      assert.throws(() => parseTrackMap(value), InvalidTrackMapError);
    }
  });
});
