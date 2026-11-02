import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SpeechGate, MAX_SPEECH_SECONDS, type SpeechGateEvent } from "../lib/audio/vad";
import { separationSteps, type ProjectRecord } from "../lib/projects/types";
import { buildStepLinks, stepNumber } from "../lib/steps";
import { scaleVideoArea, videoAreaFromDrag } from "../lib/studio/area";
import { addToTake, type TakeNote } from "../lib/studio/take";

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
