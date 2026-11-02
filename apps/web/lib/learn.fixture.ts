import assert from "node:assert/strict";
import type { KeySample, SamplerNote } from "./audio/key-sampler";
import type { SpeechGateEvent } from "./audio/vad";
import type { TakeNote } from "./studio/take";

type SamplerModule = {
  pickKeySamples: (notes: readonly SamplerNote[]) => KeySample[];
  nearestKeySample: (samples: readonly KeySample[], pitch: number) => KeySample | null;
  arrangementOctaveOffset: (arrangement: readonly SamplerNote[], raw: readonly SamplerNote[]) => number;
};
type TakeModule = { addToTake: <Dot extends TakeNote>(take: readonly Dot[], dot: Dot) => Dot[] };
type Gate = { push: (level: number, seconds: number) => SpeechGateEvent | null; learnRoom: (level: number) => void };
type VadModule = { SpeechGate: new () => Gate; MAX_SPEECH_SECONDS: number };

const SAMPLER_PATH: string = "./audio/key-sampler.ts";
const TAKE_PATH: string = "./studio/take.ts";
const VAD_PATH: string = "./audio/vad.ts";
const sampler: SamplerModule = await import(SAMPLER_PATH);
const { addToTake }: TakeModule = await import(TAKE_PATH);
const { SpeechGate, MAX_SPEECH_SECONDS }: VadModule = await import(VAD_PATH);

const note = (pitch: number, start: number, end: number, velocity = 80): SamplerNote => ({ pitch, start, end, velocity });

// A note on its own wins over a louder one cut short, and a sample stops where the next note starts.
const samples = sampler.pickKeySamples([note(60, 0, 0.3, 120), note(62, 0.28, 0.5), note(60, 1, 1.8), note(64, 2, 2.05)]);
assert.deepEqual(samples.find((s) => s.pitch === 60), { pitch: 60, start: 1, end: 1.8 });
assert.equal(samples.find((s) => s.pitch === 64), undefined, "too short to be useful as a sample");
const second = samples.find((s) => s.pitch === 62);
assert.ok(second !== undefined && second.end <= 0.5);

// A note alone beats the same pitch inside a chord.
const alone = sampler.pickKeySamples([note(60, 0, 1), note(64, 0, 1), note(60, 2, 2.8)]);
assert.equal(alone.find((s) => s.pitch === 60)?.start, 2);

// Sample length never exceeds the cap.
const long = sampler.pickKeySamples([note(60, 0, 20)]);
assert.equal(long[0]?.end, 2.5);

assert.equal(sampler.nearestKeySample([], 60), null);
assert.equal(sampler.nearestKeySample(samples, 61)?.pitch, 60);

// The part moved up two octaves is detected, despite one note folded differently.
const raw = [note(36, 0, 0.4), note(38, 0.5, 0.9), note(40, 1, 1.4), note(41, 1.5, 1.9)];
const moved = [note(60, 0, 0.4), note(62, 0.5, 0.9), note(64, 1, 1.4), note(77, 1.5, 1.9)];
assert.equal(sampler.arrangementOctaveOffset(moved, raw), 24);
assert.equal(sampler.arrangementOctaveOffset(raw, raw), 0);
assert.equal(sampler.arrangementOctaveOffset([], raw), 0);

// A take keeps the whole pass, far beyond the old 49 note limit.
const dot = (time: number, pitch = 60): TakeNote => ({ time, pitch });
let take: TakeNote[] = [];
for (let index = 0; index < 200; index += 1) take = addToTake(take, dot(index * 0.1));
assert.equal(take.length, 200);

// A second pass replaces the first where it has reached, and leaves the rest until it gets there.
let looped = [dot(0), dot(1), dot(2), dot(3)];
looped = addToTake(looped, dot(0.05, 62));
assert.deepEqual(looped.map((d) => d.time).sort((a, b) => a - b), [0.05, 1, 2, 3]);
looped = addToTake(looped, dot(2.5, 64));
assert.deepEqual(looped.map((d) => d.time).sort((a, b) => a - b), [0.05, 2.5, 3]);

// The gate: steady room noise stays quiet, speech opens and closes it, a click is thrown away.
const FRAME = 0.05;
function run(gate: Gate, level: number, seconds: number): (SpeechGateEvent | null)[] {
  const events: (SpeechGateEvent | null)[] = [];
  for (let t = 0; t < seconds; t += FRAME) events.push(gate.push(level, FRAME));
  return events.filter((event) => event !== null);
}
const quiet = new SpeechGate();
assert.deepEqual(run(quiet, 0.002, 5), []);
assert.deepEqual(run(quiet, 0.2, 1), ["started"]);
assert.deepEqual(run(quiet, 0.002, 1), ["ended"]);

const click = new SpeechGate();
assert.deepEqual(run(click, 0.2, 0.14), ["started"]);
assert.deepEqual(run(click, 0.001, 1), ["discarded"]);

// A breath between words ("loop bars ... five to eight") must not cut the phrase in half.
const pausing = new SpeechGate();
assert.deepEqual(run(pausing, 0.2, 0.5), ["started"]);
assert.deepEqual(run(pausing, 0.002, 0.6), []);
assert.deepEqual(run(pausing, 0.2, 0.5), []);
assert.deepEqual(run(pausing, 0.002, 1), ["ended"]);

const tooLong = new SpeechGate();
assert.deepEqual(run(tooLong, 0.2, MAX_SPEECH_SECONDS + 0.5).slice(0, 2), ["started", "ended"]);

const noisyRoom = new SpeechGate();
noisyRoom.learnRoom(0.03);
assert.deepEqual(run(noisyRoom, 0.03, 8), []);

// Music from the speakers: the voice rises above it and the phrase still ends while the music plays.
const overMusic = new SpeechGate();
overMusic.learnRoom(0.03);
assert.deepEqual(run(overMusic, 0.15, 1), ["started"]);
assert.deepEqual(run(overMusic, 0.03, 1), ["ended"]);

const quietVoice = new SpeechGate();
assert.deepEqual(run(quietVoice, 0.015, 1), ["started"]);
assert.deepEqual(run(quietVoice, 0.001, 1), ["ended"]);

console.log("learn fixtures passed");
