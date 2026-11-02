import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeStandardMidi, encodeStoreZip, formatSessionNotes } from "../lib/studio/export-pack";
import { parseTrackMap } from "../lib/trackmap/validate";
import { readFileSync } from "node:fs";
import type { Note } from "../lib/trackmap/trackmap.generated";

const NOTE: Note = { start: 0, end: 0.5, pitch: 60, velocity: 100 };

function ascii(view: DataView, offset: number, length: number): string {
  return String.fromCharCode(...Array.from({ length }, (_, index) => view.getUint8(offset + index)));
}

function trackBytes(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  const length = view.getUint32(18);
  return Array.from(new Uint8Array(buffer, 22, length));
}

describe("MIDI export", () => {
  it("writes a format 0 file a DAW can open", () => {
    const view = new DataView(encodeStandardMidi([NOTE], 120));
    assert.equal(ascii(view, 0, 4), "MThd");
    assert.equal(view.getUint32(4), 6);
    assert.equal(view.getUint16(8), 0);
    assert.equal(view.getUint16(10), 1);
    assert.equal(ascii(view, 14, 4), "MTrk");
  });

  it("carries the tempo in microseconds per beat", () => {
    const track = trackBytes(encodeStandardMidi([NOTE], 120));
    assert.deepEqual(track.slice(0, 7), [0x00, 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20]);
  });

  it("ends the track as the format requires", () => {
    const track = trackBytes(encodeStandardMidi([NOTE], 120));
    assert.deepEqual(track.slice(-3), [0xff, 0x2f, 0x00]);
  });

  it("turns each note on and off", () => {
    const track = trackBytes(encodeStandardMidi([NOTE], 120));
    assert.ok(track.includes(0x90));
    assert.ok(track.includes(0x80));
  });

  it("puts the left hand on its own channel", () => {
    const track = trackBytes(encodeStandardMidi([{ ...NOTE, hand: "left" }], 120));
    assert.ok(track.includes(0x91));
    assert.ok(!track.includes(0x90));
  });

  it("keeps odd values playable", () => {
    const track = trackBytes(
      encodeStandardMidi([{ start: -1, end: -1, pitch: 200, velocity: 900 }], 0),
    );
    const on = track.indexOf(0x90);
    assert.equal(track[on + 1], 127);
    assert.equal(track[on + 2], 127);
  });

  it("is still a valid file with no notes", () => {
    const view = new DataView(encodeStandardMidi([], 120));
    assert.equal(ascii(view, 0, 4), "MThd");
  });
});

describe("ZIP export", () => {
  const encoder = new TextEncoder();
  const entries = [
    { filename: "notes.txt", data: encoder.encode("hello") },
    { filename: "part.mid", data: new Uint8Array([1, 2, 3]) },
  ];

  it("opens with a local header and closes with the directory record", () => {
    const buffer = encodeStoreZip(entries);
    const view = new DataView(buffer);
    assert.equal(view.getUint32(0, true), 0x04034b50);
    assert.equal(view.getUint32(buffer.byteLength - 22, true), 0x06054b50);
    assert.equal(view.getUint16(buffer.byteLength - 22 + 10, true), 2);
  });

  it("stores each file unchanged, with its name and the right checksum", () => {
    const buffer = encodeStoreZip(entries);
    const view = new DataView(buffer);
    assert.equal(view.getUint16(8, true), 0);
    assert.equal(view.getUint32(14, true), 0x3610a686);
    assert.equal(view.getUint32(18, true), 5);
    assert.equal(ascii(view, 30, 9), "notes.txt");
    assert.equal(ascii(view, 39, 5), "hello");
  });

  it("is a valid empty archive with no files", () => {
    const buffer = encodeStoreZip([]);
    assert.equal(buffer.byteLength, 22);
  });
});

describe("session notes", () => {
  it("states the facts of the clip and the sound", () => {
    const trackMap = parseTrackMap(
      JSON.parse(readFileSync(new URL("./fixtures/trackmap.json", import.meta.url), "utf8")),
    );
    const isolation = trackMap.isolations[0];
    assert.ok(isolation !== undefined);
    const notes = formatSessionNotes(trackMap, isolation);
    assert.ok(notes.includes(`Title: ${trackMap.source.title}`));
    assert.ok(notes.includes(`Tempo: ${Math.round(trackMap.tempo.bpm)} BPM`));
    assert.ok(notes.includes(`Sound: ${isolation.label}`));
    assert.ok(notes.includes("Bar 01:"));
  });
});
