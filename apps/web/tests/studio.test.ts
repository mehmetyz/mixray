import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpeechGate, MAX_SPEECH_SECONDS, type SpeechGateEvent } from "../lib/audio/vad";
import { separationSteps, type ProjectRecord } from "../lib/projects/types";
import { strongestPartials } from "../lib/audio/freeze";
import { sustainTail } from "../lib/audio/key-sampler";
import { buildStepLinks, stepNumber } from "../lib/steps";
import { areaAroundPaths, areaAtTime, areaOnStage, clampToStage, easeStageBox, scaleVideoArea, videoAreaFromDrag } from "../lib/studio/area";
import { addToTake, forgetPassed, startsNewPass, type PassedNote, type TakeNote } from "../lib/studio/take";

describe("drawing an area on a letterboxed video", () => {
  const video = { width: 1280, height: 720 };

  it("maps pointer positions to video pixels when the picture fills the stage", () => {
    const area = videoAreaFromDrag({ x: 64, y: 36 }, { x: 128, y: 72 }, { width: 640, height: 360 }, video);
    assert.deepEqual(area, { left: 128, top: 72, right: 256, bottom: 144 });
  });

  it("accounts for the bars beside the picture", () => {
    const area = videoAreaFromDrag({ x: 180, y: 0 }, { x: 460, y: 360 }, { width: 640, height: 360 }, {
      width: 720,
      height: 720,
    });
    assert.deepEqual(area, { left: 80, top: 0, right: 640, bottom: 720 });
  });

  it("gives the same area whichever way it was dragged", () => {
    const stage = { width: 640, height: 360 };
    assert.deepEqual(
      videoAreaFromDrag({ x: 300, y: 200 }, { x: 100, y: 50 }, stage, video),
      videoAreaFromDrag({ x: 100, y: 50 }, { x: 300, y: 200 }, stage, video),
    );
  });

  it("stops at the edge of the picture", () => {
    const area = videoAreaFromDrag({ x: -50, y: -50 }, { x: 900, y: 900 }, { width: 640, height: 360 }, video);
    assert.deepEqual(area, { left: 0, top: 0, right: 1280, bottom: 720 });
  });

  it("rescales to the engine's stored copy without leaving it", () => {
    const area = { left: 1, top: 1, right: 1919, bottom: 1079 };
    assert.deepEqual(scaleVideoArea(area, { width: 1920, height: 1080 }, video), {
      left: 0,
      top: 0,
      right: 1280,
      bottom: 720,
    });
  });
});

describe("the take keeps only the latest pass", () => {
  function play(times: readonly number[]): TakeNote[] {
    return times.reduce<TakeNote[]>((take, time) => addToTake(take, { time, pitch: 60 }), []);
  }

  it("keeps notes played in order", () => {
    assert.deepEqual(play([1, 2, 3]).map((note) => note.time), [1, 2, 3]);
  });

  it("replaces what a second time through a loop plays over", () => {
    const times = play([1, 2, 3, 1.5, 2.5]).map((note) => note.time);
    assert.ok(!times.includes(2));
    assert.ok(times.includes(1.5));
    assert.ok(times.includes(2.5));
  });

  it("stays bounded on a long session", () => {
    const take = Array.from({ length: 5000 }, (_, index) => index / 10).reduce<TakeNote[]>(
      (notes, time) => addToTake(notes, { time, pitch: 60 }),
      [],
    );
    assert.equal(take.length, 4000);
    assert.equal(take[take.length - 1]?.time, 499.9);
  });
});

describe("silence on a new pass", () => {
  const firstPass: PassedNote[] = [0, 1, 2, 3].map((time) => ({ time, pitch: 60, pass: 0 }));

  function playThrough(take: PassedNote[], pass: number, end: number): PassedNote[] {
    let kept = take;
    for (let time = 0.5; time <= end; time += 0.5) kept = forgetPassed(kept, time - 0.5, time, pass);
    return kept;
  }

  it("clears an earlier pass as the playhead crosses it", () => {
    assert.deepEqual(playThrough(firstPass, 1, 3.5).map((note) => note.time), [0]);
  });

  it("leaves what the new pass has not reached", () => {
    assert.deepEqual(playThrough(firstPass, 1, 1.5).map((note) => note.time), [0, 2, 3]);
  });

  it("keeps a wrong note played on the new pass, and no old successes with it", () => {
    const take = [...firstPass, { time: 1.2, pitch: 61, pass: 1 }];
    assert.deepEqual(playThrough(take, 1, 3.5).map((note) => note.time), [0, 1.2]);
  });

  it("leaves the first pass alone while it is being played", () => {
    assert.equal(playThrough(firstPass, 0, 3.5), firstPass);
  });

  it("does not clear what a seek jumps over", () => {
    assert.equal(forgetPassed(firstPass, 0.5, 2.5, 1), firstPass);
  });

  it("counts going back as a new pass, but not clock jitter", () => {
    assert.equal(startsNewPass(4, 1), true);
    assert.equal(startsNewPass(4, 3.99), false);
    assert.equal(startsNewPass(1, 2), false);
  });
});

describe("a held key keeps sounding", () => {
  const SAMPLE_RATE = 48000;
  const A = 440;
  const C_SHARP = 554.37;
  const E = 659.25;

  function tones(frequencies: readonly number[], seconds = 1): Float32Array {
    return Float32Array.from({ length: seconds * SAMPLE_RATE }, (_, index) =>
      frequencies.reduce((sum, hertz) => sum + Math.sin((2 * Math.PI * hertz * index) / SAMPLE_RATE), 0) * 0.2,
    );
  }

  function rms(data: Float32Array): number {
    return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
  }

  /** Sample-to-sample jumps against the level: hiss and clicks raise it. */
  function roughness(data: Float32Array): number {
    return rms(data.subarray(1).map((value, index) => value - (data[index] ?? 0))) / rms(data);
  }

  it("finds the notes of a chord", () => {
    const found = strongestPartials(tones([A, C_SHARP, E]).subarray(0, 16384), SAMPLE_RATE);
    for (const hertz of [A, C_SHARP, E]) {
      assert.ok(found.some((partial) => Math.abs(partial.hertz - hertz) < 1), `${hertz} missing`);
    }
  });

  it("leaves out what sits far under the sound", () => {
    const noisy = tones([A]);
    noisy.forEach((value, index) => {
      noisy[index] = value + 0.0001 * Math.sin(index * index);
    });
    assert.ok(strongestPartials(noisy.subarray(0, 16384), SAMPLE_RATE).length <= 3);
  });

  it("carries a chord on without the hiss around it", () => {
    const hissy = tones([A, C_SHARP]);
    hissy.forEach((value, index) => {
      hissy[index] = value + 0.02 * Math.sin(index * index);
    });
    const tail = sustainTail(hissy, SAMPLE_RATE, { pitch: 69, start: 0.1, end: 0.8 }, () => 0.25);
    assert.ok(tail !== null);
    assert.ok(roughness(tail) < roughness(hissy) * 0.7);
  });

  it("joins its end to its start with no click", () => {
    const tail = sustainTail(tones([A, C_SHARP, E]), SAMPLE_RATE, { pitch: 69, start: 0.1, end: 0.8 });
    assert.ok(tail !== null);
    const first = tail[0] ?? 0;
    const last = tail[tail.length - 1] ?? 0;
    const steepest = Math.max(...tail.subarray(0, 4800).map((value, index) => Math.abs(value - (tail[index + 1] ?? value))));
    assert.ok(Math.abs(first - last) <= steepest * 1.01);
  });

  it("carries on at the level of the note", () => {
    const chord = tones([A, C_SHARP, E]);
    const tail = sustainTail(chord, SAMPLE_RATE, { pitch: 69, start: 0.1, end: 0.8 });
    assert.ok(tail !== null);
    assert.ok(Math.abs(rms(tail) - rms(chord)) < 0.02);
  });

  it("has nothing to carry on for a note too short or silent", () => {
    assert.equal(sustainTail(tones([A]), SAMPLE_RATE, { pitch: 69, start: 0.1, end: 0.15 }), null);
    const silent = new Float32Array(SAMPLE_RATE);
    assert.equal(sustainTail(silent, SAMPLE_RATE, { pitch: 69, start: 0.1, end: 0.8 }), null);
  });
});

describe("the tracked box", () => {
  const box = (left: number) => ({ left, top: 0, right: left + 10, bottom: 10 });
  const frames = [
    { time: 1, area: box(0) },
    { time: 1.2, area: box(20) },
    { time: 3, area: box(100) },
  ];

  it("glides between the moments it knows", () => {
    assert.ok(Math.abs((areaAtTime(frames, 1.1)?.left ?? 0) - 10) < 1e-9);
  });

  it("does not show before the object is found or across a gap where it left", () => {
    assert.equal(areaAtTime(frames, 0.5), null);
    assert.equal(areaAtTime(frames, 2), null);
  });

  it("holds briefly after the last answer, then goes", () => {
    assert.equal(areaAtTime(frames, 3.2)?.left, 100);
    assert.equal(areaAtTime(frames, 4), null);
  });

  it("drifts towards the object rather than twitching, and jumps after a seek", () => {
    const here = { left: 10, top: 10, width: 20, height: 20 };
    const near = easeStageBox(here, { ...here, left: 14 }, 16).left;
    assert.ok(near > 10 && near < 11);
    assert.equal(easeStageBox(here, { ...here, left: 60 }, 16).left, 60);
  });

  it("keeps a drag inside the stage when the pointer leaves it", () => {
    assert.deepEqual(clampToStage({ x: -5, y: 900 }, { width: 640, height: 360 }), { x: 0, y: 360 });
  });

  it("wraps every outline of a frame", () => {
    const area = areaAroundPaths(["M399.0 360.0L400.0 359.0L420.5 700.0Z", "M10 20L30 40Z"]);
    assert.deepEqual(area, { left: 10, top: 20, right: 420.5, bottom: 700 });
  });

  it("has nothing to wrap on a frame without an outline", () => {
    assert.equal(areaAroundPaths([]), null);
    assert.equal(areaAroundPaths(["Z"]), null);
  });

  it("lands on the picture of a video that fills the stage", () => {
    const box = areaOnStage(
      { left: 320, top: 180, right: 960, bottom: 540 },
      { width: 1280, height: 720 },
      { width: 16, height: 9 },
    );
    assert.deepEqual(box, { left: 25, top: 25, width: 50, height: 50 });
  });

  it("lands on the picture of a vertical video letterboxed on the stage", () => {
    const box = areaOnStage(
      { left: 0, top: 0, right: 720, bottom: 1280 },
      { width: 720, height: 1280 },
      { width: 16, height: 9 },
    );
    assert.equal(box.top, 0);
    assert.equal(box.height, 100);
    assert.ok(Math.abs(box.left - 34.1796875) < 1e-9);
    assert.ok(Math.abs(box.width - 31.640625) < 1e-9);
  });
});

describe("step links", () => {
  const clip = { current: "pick", clipId: "a b", soundPicked: false } as const;

  it("always leads to a new clip from Add", () => {
    const first = buildStepLinks(clip)[0];
    assert.equal(first?.id, "add");
    assert.equal(first?.href, "/studio/new");
  });

  it("locks the steps after Isolate until a sound exists", () => {
    const links = buildStepLinks(clip);
    assert.equal(links.find((link) => link.id === "pick")?.href, "/c/a%20b/pick");
    assert.equal(links.find((link) => link.id === "xray")?.href, null);
    assert.equal(links.find((link) => link.id === "take")?.href, null);
  });

  it("opens them and carries the sound once one is picked", () => {
    const links = buildStepLinks({ ...clip, soundPicked: true, isolationId: "iso1" });
    assert.equal(links.find((link) => link.id === "learn")?.href, "/c/a%20b/learn?iso=iso1");
  });

  it("marks the current step and numbers from one", () => {
    assert.equal(buildStepLinks(clip).filter((link) => link.isCurrent).length, 1);
    assert.equal(stepNumber("add"), 1);
    assert.equal(stepNumber("take"), 5);
  });
});

describe("separation steps", () => {
  const project: ProjectRecord = { id: "a", title: "t", kind: "video", duration: 8, createdAt: 0, updatedAt: 0 };

  it("names the area first only when one was drawn", () => {
    assert.deepEqual(separationSteps(project), ["isolating", "analyzing"]);
    assert.deepEqual(separationSteps({ ...project, usesArea: true }), ["naming", "isolating", "analyzing"]);
  });
});

describe("speech gate", () => {
  const FRAME = 0.05;
  const LOUD = 0.2;
  const SILENT = 0.001;

  function feed(gate: SpeechGate, level: number, seconds: number): SpeechGateEvent[] {
    const events: SpeechGateEvent[] = [];
    for (let elapsed = 0; elapsed < seconds; elapsed += FRAME) {
      const event = gate.push(level, FRAME);
      if (event !== null) events.push(event);
    }
    return events;
  }

  it("hears nothing in silence", () => {
    assert.deepEqual(feed(new SpeechGate(), SILENT, 3), []);
  });

  it("starts on a voice and ends after a pause", () => {
    const gate = new SpeechGate();
    assert.deepEqual(feed(gate, LOUD, 1), ["started"]);
    assert.deepEqual(feed(gate, SILENT, 1), ["ended"]);
  });

  it("does not start on a click", () => {
    const gate = new SpeechGate();
    assert.deepEqual(feed(gate, LOUD, 0.05), []);
    assert.deepEqual(feed(gate, SILENT, 1), []);
  });

  it("discards a phrase too short to be speech", () => {
    const gate = new SpeechGate();
    assert.deepEqual(feed(gate, LOUD, 0.15), ["started"]);
    assert.deepEqual(feed(gate, SILENT, 1), ["discarded"]);
  });

  it("cuts a phrase that never stops", () => {
    const events = feed(new SpeechGate(), LOUD, MAX_SPEECH_SECONDS + 0.2);
    assert.deepEqual(events.slice(0, 2), ["started", "ended"]);
  });

  it("ends a phrase when music keeps playing underneath it", () => {
    const gate = new SpeechGate();
    assert.deepEqual(feed(gate, LOUD, 1), ["started"]);
    assert.deepEqual(feed(gate, LOUD * 0.1, 1).slice(0, 1), ["ended"]);
  });

  it("needs a voice above a loud room", () => {
    const gate = new SpeechGate();
    gate.learnRoom(0.04);
    assert.deepEqual(feed(gate, 0.05, 1), []);
    assert.deepEqual(feed(gate, LOUD, 1), ["started"]);
  });

  it("does not let someone already talking raise the bar above their voice", () => {
    const gate = new SpeechGate();
    gate.learnRoom(LOUD);
    assert.deepEqual(feed(gate, LOUD, 1), ["started"]);
  });
});
