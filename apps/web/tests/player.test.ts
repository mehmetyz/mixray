import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { StemPlayer } from "../lib/audio/player";

/** Just enough of a media element: time moves only when a test moves it. */
class FakeAudio {
  static made: FakeAudio[] = [];
  url: string;
  currentTime = 0;
  duration = 10;
  paused = true;
  ended = false;
  volume = 1;
  playbackRate = 1;
  preservesPitch = false;
  crossOrigin: string | null = null;
  preload = "";
  src = "";

  constructor(url: string) {
    this.url = url;
    FakeAudio.made.push(this);
  }

  async play(): Promise<void> {
    this.paused = false;
    this.ended = false;
  }

  pause(): void {
    this.paused = true;
  }

  finish(): void {
    this.currentTime = this.duration;
    this.paused = true;
    this.ended = true;
  }
}

class FakeGain {
  gain = {
    value: 0,
    cancelScheduledValues: () => undefined,
    setValueAtTime: () => undefined,
    linearRampToValueAtTime: (value: number) => {
      this.gain.value = value;
    },
  };

  connect(): this {
    return this;
  }

  disconnect(): void {}
}

class FakeAudioContext {
  currentTime = 0;
  destination = {};
  gains: FakeGain[] = [];

  async resume(): Promise<void> {}

  async close(): Promise<void> {}

  createGain(): FakeGain {
    const gain = new FakeGain();
    FakeAudioContext.lastGains.push(gain);
    return gain;
  }

  createMediaElementSource(): FakeGain {
    return new FakeGain();
  }

  static lastGains: FakeGain[] = [];
}

let runTick: () => void = () => undefined;

function fakeBrowser(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { configurable: true, value });
}

fakeBrowser("Audio", FakeAudio);
fakeBrowser("AudioContext", FakeAudioContext);
fakeBrowser("window", {
  setInterval: (callback: () => void) => {
    runTick = callback;
    return 1;
  },
  clearInterval: () => {
    runTick = () => undefined;
  },
});

const STEMS = [
  { name: "mix", url: "/mix.mp3" },
  { name: "sound", url: "/sound.mp3" },
  { name: "rest", url: "/rest.mp3" },
] as const;

function element(index: number): FakeAudio {
  const made = FakeAudio.made[index];
  assert.ok(made !== undefined);
  return made;
}

beforeEach(() => {
  FakeAudio.made = [];
  FakeAudioContext.lastGains = [];
  runTick = () => undefined;
  mock.restoreAll();
});

describe("playing and pausing", () => {
  it("needs something to play", () => {
    assert.throws(() => new StemPlayer([]), /at least one stem/);
  });

  it("plays and pauses every stem together", async () => {
    const player = new StemPlayer([...STEMS]);
    await player.play();
    assert.equal(player.playing, true);
    assert.ok(FakeAudio.made.every((audio) => !audio.paused));
    player.pause();
    assert.equal(player.playing, false);
    assert.ok(FakeAudio.made.every((audio) => audio.paused));
  });

  it("can play the mix alone before any sound exists", async () => {
    const player = new StemPlayer([{ name: "mix", url: "/mix.mp3" }]);
    await player.play();
    assert.equal(player.playing, true);
    assert.equal(player.activeStem, "mix");
  });

  it("starts again from the top when Play is pressed after the clip ended", async () => {
    const player = new StemPlayer([...STEMS]);
    await player.play();
    FakeAudio.made.forEach((audio) => audio.finish());
    await player.play();
    assert.ok(FakeAudio.made.every((audio) => audio.currentTime === 0));
    assert.equal(player.playing, true);
  });

  it("starts from the loop, not the top, when a loop is set", async () => {
    const player = new StemPlayer([...STEMS]);
    player.setLoop({ startSeconds: 4, endSeconds: 6 });
    FakeAudio.made.forEach((audio) => audio.finish());
    await player.play();
    assert.equal(player.currentTime, 4);
  });

  it("reports the end of the clip once and stops", async () => {
    const ended = mock.fn();
    const player = new StemPlayer([...STEMS], { onEnded: ended });
    await player.play();
    FakeAudio.made.forEach((audio) => audio.finish());
    runTick();
    assert.equal(ended.mock.callCount(), 1);
    assert.equal(player.playing, false);
  });
});

describe("looping", () => {
  it("jumps back at the end of the loop", async () => {
    const player = new StemPlayer([...STEMS]);
    player.setLoop({ startSeconds: 2, endSeconds: 4 });
    await player.play();
    FakeAudio.made.forEach((audio) => {
      audio.currentTime = 4;
    });
    runTick();
    assert.ok(FakeAudio.made.every((audio) => audio.currentTime === 2));
    assert.equal(player.playing, true);
  });

  it("keeps playing when the loop reaches the end of the clip", async () => {
    const ended = mock.fn();
    const player = new StemPlayer([...STEMS], { onEnded: ended });
    player.setLoop({ startSeconds: 8, endSeconds: 10 });
    await player.play();
    FakeAudio.made.forEach((audio) => audio.finish());
    runTick();
    await Promise.resolve();
    assert.equal(player.currentTime, 8);
    assert.equal(player.playing, true);
    assert.equal(ended.mock.callCount(), 0);
  });

  it("moves into a new loop that starts ahead, and leaves time alone otherwise", () => {
    const player = new StemPlayer([...STEMS]);
    player.setLoop({ startSeconds: 5, endSeconds: 7 });
    assert.equal(player.currentTime, 5);
    player.setLoop({ startSeconds: 1, endSeconds: 7 });
    assert.equal(player.currentTime, 5);
  });
});

describe("what is heard", () => {
  it("starts on the first stem with the others silent", () => {
    new StemPlayer([...STEMS]);
    assert.deepEqual(FakeAudioContext.lastGains.map((gain) => gain.gain.value), [1, 0, 0]);
  });

  it("switching changes only the gains, so the stems stay in step", async () => {
    const player = new StemPlayer([...STEMS]);
    await player.play();
    element(1).currentTime = 3;
    player.setActive("sound");
    assert.equal(player.activeStem, "sound");
    assert.deepEqual(FakeAudioContext.lastGains.map((gain) => gain.gain.value), [0, 1, 0]);
    assert.equal(element(1).currentTime, 3);
    assert.equal(player.playing, true);
  });

  it("ignores a stem it does not have", () => {
    const player = new StemPlayer([{ name: "mix", url: "/mix.mp3" }]);
    player.setActive("sound");
    assert.equal(player.activeStem, "mix");
  });

  it("turns down for the microphone and back up", () => {
    const player = new StemPlayer([...STEMS]);
    player.setDucked(true);
    assert.ok(FakeAudio.made.every((audio) => audio.volume === 0.2));
    player.setDucked(false);
    assert.ok(FakeAudio.made.every((audio) => audio.volume === 1));
  });
});

describe("speed and time", () => {
  it("keeps the pitch when the tempo changes, within limits", () => {
    const player = new StemPlayer([...STEMS]);
    player.setRate(0.5);
    assert.ok(FakeAudio.made.every((audio) => audio.playbackRate === 0.5 && audio.preservesPitch));
    player.setRate(0.01);
    assert.equal(element(0).playbackRate, 0.25);
    player.setRate(9);
    assert.equal(element(0).playbackRate, 2);
  });

  it("keeps a seek inside the clip and reports it", () => {
    const seen: number[] = [];
    const player = new StemPlayer([...STEMS], { onTime: (seconds) => seen.push(seconds) });
    player.seek(99);
    player.seek(-5);
    assert.deepEqual(seen, [10, 0]);
  });

  it("does not stop over an element not ready to seek", () => {
    const player = new StemPlayer([{ name: "mix", url: "/mix.mp3" }]);
    Object.defineProperty(element(0), "currentTime", {
      set: () => {
        throw new Error("not ready");
      },
      get: () => 0,
    });
    assert.doesNotThrow(() => player.seek(3));
  });

  it("pulls a drifting stem back onto the leader's clock", async () => {
    const player = new StemPlayer([...STEMS]);
    await player.play();
    element(0).currentTime = 5;
    element(1).currentTime = 5.05;
    element(2).currentTime = 6;
    runTick();
    assert.equal(element(1).currentTime, 5.05);
    assert.equal(element(2).currentTime, 5);
  });

  it("reads zero until the duration is known", () => {
    const player = new StemPlayer([{ name: "mix", url: "/mix.mp3" }]);
    element(0).duration = Number.NaN;
    assert.equal(player.duration, 0);
  });
});

describe("cleaning up", () => {
  it("stops and lets go of everything", async () => {
    const player = new StemPlayer([...STEMS]);
    await player.play();
    await player.dispose();
    assert.ok(FakeAudio.made.every((audio) => audio.paused && audio.src === ""));
    assert.equal(player.playing, false);
    assert.equal(player.currentTime, 0);
  });
});
