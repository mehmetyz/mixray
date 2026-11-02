import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  barAtTime,
  barRangeToSeconds,
  deriveMixPeaks,
  firstSoundingBar,
  formatBarBeat,
  formatClockSeconds,
  formatPitchRange,
  keyLabel,
  midiToNoteName,
  tempoLabel,
} from "../lib/studio/format";
import type { Note } from "../lib/trackmap/trackmap.generated";

function note(start: number, pitch: number, bar?: number): Note {
  return { start, end: start + 0.5, pitch, velocity: 90, ...(bar === undefined ? {} : { bar }) };
}

describe("note names", () => {
  it("names MIDI pitches with C4 as middle C", () => {
    assert.equal(midiToNoteName(60), "C4");
    assert.equal(midiToNoteName(69), "A4");
    assert.equal(midiToNoteName(21), "A0");
  });

  it("clamps pitches outside the MIDI range", () => {
    assert.equal(midiToNoteName(-5), midiToNoteName(0));
    assert.equal(midiToNoteName(300), midiToNoteName(127));
  });

  it("writes a range from the stored range or from the notes", () => {
    assert.equal(formatPitchRange({ low: 48, high: 72 }, []), "C3–C5");
    assert.equal(formatPitchRange(undefined, [note(0, 64), note(1, 60), note(2, 67)]), "C4–G4");
    assert.equal(formatPitchRange(undefined, []), "—");
  });
});

describe("first sounding bar", () => {
  const downbeats = [0, 2, 4, 6];

  it("is a dash without notes", () => assert.equal(firstSoundingBar([], downbeats), "—"));

  it("uses the bar stored on the earliest note", () => {
    assert.equal(firstSoundingBar([note(5, 60, 2), note(3, 60, 1)], downbeats), "Bar 2");
  });

  it("finds the bar from the time when none is stored", () => {
    assert.equal(firstSoundingBar([note(4.5, 60)], downbeats), "Bar 3");
  });
});

describe("clock", () => {
  it("reads minutes, seconds and tenths", () => {
    assert.equal(formatClockSeconds(0), "00:00.0");
    assert.equal(formatClockSeconds(65.25), "01:05.2");
  });

  it("survives values that are not a time", () => {
    assert.equal(formatClockSeconds(Number.NaN), "00:00.0");
    assert.equal(formatClockSeconds(-3), "00:00.0");
  });
});

describe("bar and beat display", () => {
  const downbeats = [0, 2, 4];

  it("counts bars and beats from one", () => {
    assert.equal(formatBarBeat(0, downbeats, [4, 4], 6), "01.1");
    assert.equal(formatBarBeat(0.5, downbeats, [4, 4], 6), "01.2");
    assert.equal(formatBarBeat(3.5, downbeats, [4, 4], 6), "02.4");
    assert.equal(formatBarBeat(5.9, downbeats, [4, 4], 6), "03.4");
  });

  it("has an answer before any analysis exists", () => {
    assert.equal(formatBarBeat(3, [], [4, 4], 6), "01.1");
  });

  it("follows a three-beat bar", () => {
    assert.equal(formatBarBeat(1.9, [0, 2], [3, 4], 4), "01.3");
  });
});

describe("bars to seconds", () => {
  const downbeats = [0, 2, 4, 6];

  it("covers the bars asked for, end bar included", () => {
    assert.deepEqual(barRangeToSeconds(2, 3, downbeats, 8), { startSeconds: 2, endSeconds: 6 });
  });

  it("runs the last bar to the end of the clip", () => {
    assert.deepEqual(barRangeToSeconds(4, 4, downbeats, 8), { startSeconds: 6, endSeconds: 8 });
  });

  it("keeps a range that leaves the piece inside it, and at least one bar long", () => {
    assert.deepEqual(barRangeToSeconds(-3, 99, downbeats, 8), { startSeconds: 0, endSeconds: 8 });
    assert.deepEqual(barRangeToSeconds(3, 1, downbeats, 8), { startSeconds: 4, endSeconds: 6 });
  });
});

describe("bar at a time", () => {
  const downbeats = [1, 3, 5];

  it("counts from one and calls the pickup bar 1", () => {
    assert.equal(barAtTime(0, downbeats), 1);
    assert.equal(barAtTime(1, downbeats), 1);
    assert.equal(barAtTime(3, downbeats), 2);
    assert.equal(barAtTime(100, downbeats), 3);
  });
});

describe("mix waveform", () => {
  it("adds sound and rest by power, under full scale", () => {
    assert.deepEqual(deriveMixPeaks([0.3], [0.4]), [0.5]);
    assert.deepEqual(deriveMixPeaks([1], [1]), [0.96]);
  });

  it("is as long as the longer of the two", () => {
    assert.equal(deriveMixPeaks([0.1, 0.1, 0.1], [0.1]).length, 3);
  });
});

describe("tempo and key that were not measured", () => {
  it("are shown as unknown rather than as their placeholder values", () => {
    assert.equal(tempoLabel({ bpm: 120, time_signature: [4, 4], confidence: 0 }), "Tempo unknown");
    assert.equal(keyLabel({ tonic: "A", mode: "minor", confidence: 0 }), "Key unknown");
  });

  it("are shown when they were", () => {
    assert.equal(tempoLabel({ bpm: 96.4, time_signature: [4, 4], confidence: 0.2 }), "96 BPM");
    assert.equal(keyLabel({ tonic: "C", mode: "major", confidence: 0.2 }), "C major");
  });
});
