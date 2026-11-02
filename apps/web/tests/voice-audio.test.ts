import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { padWithSilence, resampleToTarget } from "../lib/audio/voice";

const SOURCE_RATE = 48_000;

function tone(hertz: number): Float32Array {
  return Float32Array.from({ length: SOURCE_RATE }, (_, index) => Math.sin((2 * Math.PI * hertz * index) / SOURCE_RATE));
}

function rms(samples: Float32Array): number {
  const middle = samples.subarray(200, samples.length - 200);
  return Math.sqrt(middle.reduce((sum, value) => sum + value * value, 0) / middle.length);
}

describe("preparing the microphone for the model", () => {
  it("keeps speech", () => {
    assert.ok(Math.abs(rms(resampleToTarget(tone(1000), SOURCE_RATE)) - rms(tone(1000))) < 0.03);
  });

  it("does not let sound above the new rate fold down onto speech", () => {
    assert.ok(rms(resampleToTarget(tone(13_000), SOURCE_RATE)) < 0.03);
  });

  it("leaves a recording already at the rate alone", () => {
    const samples = new Float32Array(16);
    assert.equal(resampleToTarget(samples, 16_000), samples);
  });

  it("gives the length the new rate calls for", () => {
    assert.equal(resampleToTarget(tone(440), SOURCE_RATE).length, 16_000);
  });

  it("puts silence on both sides of the voice", () => {
    const padded = padWithSilence(Float32Array.from([0.5, -0.5]), 10);
    assert.deepEqual(Array.from(padded), [0, 0, 0, 0, 0.5, -0.5, 0, 0, 0, 0]);
  });
});
