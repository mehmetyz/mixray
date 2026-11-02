import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  matchSoundByName,
  parseStudioCommand,
  parseVoiceAssistantMessage,
  parseVoiceCoachCommand,
  isExactCommand,
  isLatinScript,
  VOICE_COMMAND_HELP,
  type StudioCommand,
} from "../lib/voice-commands";
import type { CoachAction } from "../lib/coach";

type StudioCase = [phrase: string, command: StudioCommand];
type CoachCase = [phrase: string, action: CoachAction];

const STUDIO_PHRASES: readonly StudioCase[] = [
  ["play", { name: "play" }],
  ["resume", { name: "play" }],
  ["let's go", { name: "play" }],
  ["pause", { name: "pause" }],
  ["stop", { name: "pause" }],
  ["hold on", { name: "pause" }],
  ["restart", { name: "restart" }],
  ["from the top", { name: "restart" }],
  ["start over", { name: "restart" }],
  ["again", { name: "restart" }],
  ["bar 5", { name: "seek_bar", bar: 5 }],
  ["go to bar 12", { name: "seek_bar", bar: 12 }],
  ["play from bar 3", { name: "seek_bar", bar: 3 }],
  ["back 2 bars", { name: "seek_relative", bars: -2 }],
  ["go back", { name: "seek_relative", bars: -1 }],
  ["previous bar", { name: "seek_relative", bars: -1 }],
  ["forward 4 bars", { name: "seek_relative", bars: 4 }],
  ["next bar", { name: "seek_relative", bars: 1 }],
  ["2 bar left", { name: "seek_relative", bars: -2 }],
  ["4 bars to the right", { name: "seek_relative", bars: 4 }],
  ["a bar left", { name: "seek_relative", bars: -1 }],
  ["loop", { name: "loop_here", bars: 4 }],
  ["loop this bar", { name: "loop_here", bars: 1 }],
  ["loop 2 bars", { name: "loop_here", bars: 2 }],
  ["loop the next 8 bars", { name: "loop_here", bars: 8 }],
  ["loop off", { name: "loop_off" }],
  ["stop the loop", { name: "loop_off" }],
  ["slower", { name: "tempo_step", delta: -10 }],
  ["a bit slower", { name: "tempo_step", delta: -10 }],
  ["slow it down", { name: "tempo_step", delta: -10 }],
  ["faster", { name: "tempo_step", delta: 10 }],
  ["speed up", { name: "tempo_step", delta: 10 }],
  ["full mix", { name: "monitor", stem: "mix" }],
  ["with the band", { name: "monitor", stem: "mix" }],
  ["backing track", { name: "monitor", stem: "rest" }],
  ["play along", { name: "monitor", stem: "rest" }],
  ["solo", { name: "monitor", stem: "sound" }],
  ["just the sound", { name: "monitor", stem: "sound" }],
  ["easy", { name: "level", level: "easy" }],
  ["switch to intermediate", { name: "level", level: "intermediate" }],
  ["octave up", { name: "octave", delta: 1 }],
  ["down an octave", { name: "octave", delta: -1 }],
  ["go to isolate", { name: "go_to", screen: "pick" }],
  ["open analyze", { name: "go_to", screen: "xray" }],
  ["show the practice screen", { name: "go_to", screen: "learn" }],
  ["go to export", { name: "go_to", screen: "take" }],
  ["switch to the piano", { name: "select_sound", sound: "piano" }],
  ["listen to vocals", { name: "select_sound", sound: "vocals" }],
  ["what is the tempo", { name: "tell", fact: "tempo" }],
  ["what's the key", { name: "tell", fact: "key" }],
  ["which bar", { name: "tell", fact: "bar" }],
  ["help", { name: "help" }],
  ["what can i say", { name: "help" }],
];

const COACH_PHRASES: readonly CoachCase[] = [
  ["loop 4 to 8", { name: "set_loop", args: { start_bar: 4, end_bar: 8 } }],
  ["bars 2 and 3", { name: "set_loop", args: { start_bar: 2, end_bar: 3 } }],
  ["loop bars five to eight", { name: "set_loop", args: { start_bar: 5, end_bar: 8 } }],
  ["loop bar 5", { name: "set_loop", args: { start_bar: 4, end_bar: 7 } }],
  ["half speed", { name: "set_tempo", args: { percent: 50 } }],
  ["normal speed", { name: "set_tempo", args: { percent: 100 } }],
  ["slow down to 60 percent", { name: "set_tempo", args: { percent: 60 } }],
  ["tempo seventy five", { name: "set_tempo", args: { percent: 75 } }],
  ["tempo 10", { name: "set_tempo", args: { percent: 40 } }],
  ["left hand", { name: "switch_hand", args: { hand: "left" } }],
  ["right hand", { name: "switch_hand", args: { hand: "right" } }],
  ["both hands", { name: "switch_hand", args: { hand: "both" } }],
  ["simplify bar 3", { name: "simplify_bar", args: { bar: 3 } }],
  ["hey mixray simplify bar nine", { name: "simplify_bar", args: { bar: 9 } }],
];

describe("studio commands", () => {
  for (const [phrase, command] of STUDIO_PHRASES) {
    it(`reads "${phrase}"`, () => assert.deepEqual(parseStudioCommand(phrase), command));
  }

  it("does not mistake hands or speed for a sound", () => {
    assert.equal(parseStudioCommand("use both hands"), null);
    assert.equal(parseStudioCommand("left hand"), null);
    assert.equal(parseStudioCommand("switch to normal speed"), null);
  });

  it("answers null to what it does not know", () => {
    assert.equal(parseStudioCommand("banana"), null);
    assert.equal(parseStudioCommand(""), null);
  });
});

describe("coach commands", () => {
  for (const [phrase, action] of COACH_PHRASES) {
    it(`reads "${phrase}"`, () => assert.deepEqual(parseVoiceCoachCommand(phrase), action));
  }

  it("does not pick a hand from a direction", () => {
    // Heard in the app: "two bar left" came back as "full bar left" and set the left hand.
    assert.equal(parseVoiceCoachCommand("full bar left"), null);
    assert.equal(parseVoiceCoachCommand("that's right"), null);
  });

  it("keeps a loop at least one bar long and inside the piece", () => {
    assert.deepEqual(parseVoiceCoachCommand("loop 8 to 2"), {
      name: "set_loop",
      args: { start_bar: 8, end_bar: 9 },
    });
    assert.deepEqual(parseVoiceCoachCommand("loop 0 to 3"), {
      name: "set_loop",
      args: { start_bar: 1, end_bar: 3 },
    });
  });

  it("ignores a phrase that is only the wake word, or nothing", () => {
    assert.equal(parseVoiceCoachCommand("hey mixray"), null);
    assert.equal(parseVoiceCoachCommand("   "), null);
  });
});

describe("whole spoken messages", () => {
  it("reads numbers written as words, as Muse Voice Transcribe writes them", () => {
    const { intent } = parseVoiceAssistantMessage("Go to bar twenty one.");
    assert.equal(intent.kind, "studio");
    if (intent.kind === "studio") assert.deepEqual(intent.command, { name: "seek_bar", bar: 21 });
  });

  it("survives the stutters measured on live transcripts", () => {
    const { intent } = parseVoiceAssistantMessage("go to bar bar five");
    assert.equal(intent.kind, "studio");
    if (intent.kind === "studio") assert.deepEqual(intent.command, { name: "seek_bar", bar: 5 });
  });

  it("ignores politeness and punctuation", () => {
    const { intent } = parseVoiceAssistantMessage("Play, please!");
    assert.equal(intent.kind, "studio");
    if (intent.kind === "studio") assert.deepEqual(intent.command, { name: "play" });
  });

  it("notices the wake word and takes the command after it", () => {
    const parsed = parseVoiceAssistantMessage("Hey Mix Ray, pause");
    assert.equal(parsed.wakeWordDetected, true);
    assert.equal(parsed.intent.kind, "studio");
    assert.equal(parsed.cleanTranscript, "pause");
  });

  it("answers the wake word alone with a greeting", () => {
    assert.equal(parseVoiceAssistantMessage("okay mixray").intent.kind, "greeting");
  });

  for (const phrase of ["how did i do", "get feedback", "review that"]) {
    it(`asks the Coach on "${phrase}"`, () => {
      assert.equal(parseVoiceAssistantMessage(phrase).intent.kind, "analyze");
    });
  }

  it("resets on reset", () => {
    assert.equal(parseVoiceAssistantMessage("reset everything").intent.kind, "reset");
  });

  it("turns a loop range into a Coach tool with a description", () => {
    const { intent } = parseVoiceAssistantMessage("loop four to eight");
    assert.equal(intent.kind, "action");
    assert.equal(intent.description, "Looped bars 4–8");
  });

  it("tells the player what to try when nothing matched", () => {
    const { intent } = parseVoiceAssistantMessage("what a lovely day");
    assert.equal(intent.kind, "unknown");
    assert.match(intent.description, /Try/);
  });

  it("describes every studio command in words", () => {
    for (const [phrase] of STUDIO_PHRASES) {
      const { intent } = parseVoiceAssistantMessage(phrase);
      assert.ok(intent.description.length > 0, phrase);
    }
  });

  it("documents at least one example per topic", () => {
    assert.ok(VOICE_COMMAND_HELP.length > 0);
    for (const entry of VOICE_COMMAND_HELP) assert.ok(entry.examples.length > 0, entry.topic);
  });
});

describe("what runs without asking the model", () => {
  it("is a command said word for word, however it was punctuated", () => {
    for (const phrase of ["Play.", "next bar", "Two bars back.", "back two bars", "loop four to eight", "Octave up!"]) {
      assert.equal(isExactCommand(phrase), true, phrase);
    }
  });

  it("is never a sentence that merely contains a command word", () => {
    for (const phrase of ["I played that wrong", "my left hand hurts", "go back to the part I like", "again and again", "play the bass"]) {
      assert.equal(isExactCommand(phrase), false, phrase);
    }
  });
});

describe("what counts as English", () => {
  it("refuses other scripts, as measured from accented speech", () => {
    assert.equal(isLatinScript("بارسفای普لейت"), false);
    assert.equal(isLatinScript("two bars 回"), false);
  });

  it("lets Latin text and numbers through for the model to judge", () => {
    assert.equal(isLatinScript("Go back to Barth."), true);
    assert.equal(isLatinScript("loop 4 to 8"), true);
  });
});

describe("saying a command loosely", () => {
  const moves: readonly (readonly [string, number])[] = [
    // Transcripts measured from Muse Voice Transcribe.
    ["two bars back.", -2],
    ["Two bars back..", -2],
    ["Back two bars.", -2],
    ["Go back to Barth.", -2],
    ["Gol back to bars.", -2],
    ["Next bar.", 1],
    // Other ways to say a move.
    ["go back two bars", -2],
    ["rewind two bars", -2],
    ["two bars ago", -2],
    ["back two", -2],
    ["a bar back", -1],
    ["one bar back", -1],
    ["go back a bar", -1],
    ["back a couple of bars", -2],
    ["last two bars", -2],
    ["go backwards", -1],
    ["three bars forward", 3],
    ["skip two bars", 2],
    ["skip ahead two bars", 2],
    ["next two bars", 2],
    ["could you go back two bars please", -2],
  ];

  for (const [phrase, bars] of moves) {
    it(`moves ${bars} for "${phrase}"`, () => {
      const { intent } = parseVoiceAssistantMessage(phrase);
      assert.equal(intent.kind, "studio");
      assert.deepEqual(intent.kind === "studio" ? intent.command : null, { name: "seek_relative", bars });
    });
  }

  const others: readonly (readonly [string, StudioCommand])[] = [
    ["go back to bar five", { name: "seek_bar", bar: 5 }],
    ["go back to the start", { name: "restart" }],
    ["can you play", { name: "play" }],
    ["let's go", { name: "play" }],
    ["pause now", { name: "pause" }],
    ["slow down a bit", { name: "tempo_step", delta: -10 }],
    ["loop to bars", { name: "loop_here", bars: 2 }],
    ["play the backing track", { name: "monitor", stem: "rest" }],
  ];

  for (const [phrase, command] of others) {
    it(`understands "${phrase}"`, () => {
      const { intent } = parseVoiceAssistantMessage(phrase);
      assert.deepEqual(intent.kind === "studio" ? intent.command : null, command);
    });
  }

  it("does not take a bare number or a speed for a move", () => {
    for (const phrase of ["two bars", "playback", "back to 100 percent"]) {
      const { intent } = parseVoiceAssistantMessage(phrase);
      assert.notEqual(intent.kind === "studio" ? intent.command.name : null, "seek_relative", phrase);
    }
  });
});

describe("matching a spoken sound name", () => {
  const sounds = [
    { label: "Grand Piano", prompt: "piano" },
    { label: "Lead Vocals", prompt: "vocals" },
  ];

  it("finds a sound by label, prompt or part of the name", () => {
    assert.equal(matchSoundByName(sounds, "Grand Piano"), sounds[0]);
    assert.equal(matchSoundByName(sounds, "vocals"), sounds[1]);
    assert.equal(matchSoundByName(sounds, "piano"), sounds[0]);
    assert.equal(matchSoundByName(sounds, "the lead vocals please"), sounds[1]);
  });

  it("returns nothing for a sound the clip does not have", () => {
    assert.equal(matchSoundByName(sounds, "drums"), undefined);
  });
});
