import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeWav, InvalidAudioError } from "../lib/audio/wav";

function ascii(view: DataView, offset: number): string {
  return String.fromCharCode(...[0, 1, 2, 3].map((index) => view.getUint8(offset + index)));
}

describe("WAV encoding", () => {
  it("writes a header ffmpeg can read", () => {
    const buffer = encodeWav({ channels: [new Float32Array(4), new Float32Array(4)], sampleRate: 48_000 });
    const view = new DataView(buffer);
    assert.equal(ascii(view, 0), "RIFF");
    assert.equal(view.getUint32(4, true), 36 + 16);
    assert.equal(ascii(view, 8), "WAVE");
    assert.equal(view.getUint16(20, true), 1);
    assert.equal(view.getUint16(22, true), 2);
    assert.equal(view.getUint32(24, true), 48_000);
    assert.equal(view.getUint32(28, true), 48_000 * 4);
    assert.equal(view.getUint16(32, true), 4);
    assert.equal(view.getUint16(34, true), 16);
    assert.equal(ascii(view, 36), "data");
    assert.equal(view.getUint32(40, true), 16);
    assert.equal(buffer.byteLength, 44 + 16);
  });

  it("interleaves the channels", () => {
    const view = new DataView(
      encodeWav({ channels: [new Float32Array([1, 0]), new Float32Array([0, 1])], sampleRate: 8000 }),
    );
    assert.equal(view.getInt16(44, true), 32767);
    assert.equal(view.getInt16(46, true), 0);
    assert.equal(view.getInt16(48, true), 0);
    assert.equal(view.getInt16(50, true), 32767);
  });

  it("clips samples beyond full scale instead of wrapping around", () => {
    const view = new DataView(encodeWav({ channels: [new Float32Array([2, -2])], sampleRate: 8000 }));
    assert.equal(view.getInt16(44, true), 32767);
    assert.equal(view.getInt16(46, true), -32768);
  });

  it("refuses audio it cannot describe", () => {
    assert.throws(() => encodeWav({ channels: [], sampleRate: 8000 }), InvalidAudioError);
    assert.throws(() => encodeWav({ channels: [new Float32Array(1)], sampleRate: 0 }), InvalidAudioError);
    assert.throws(
      () => encodeWav({ channels: [new Float32Array(1), new Float32Array(2)], sampleRate: 8000 }),
      InvalidAudioError,
    );
  });
});
