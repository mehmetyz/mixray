import assert from "node:assert/strict";
import type { CoachAction, CoachReply } from "./coach";
import type { ParsedVoiceMessage, StudioCommand } from "./voice-commands";

type ParseVoiceCoachCommand = (phrase: string) => CoachAction | null;

type VoiceModule = {
  parseVoiceCoachCommand: ParseVoiceCoachCommand;
  parseVoiceAssistantMessage: (phrase: string) => ParsedVoiceMessage;
};

type CoachModule = {
  parseCoachModelReply: (reply: unknown, barCount: number) => CoachReply;
  parseCoachRouteReply: (reply: unknown, barCount: number) => CoachReply;
  INVALID_COACH_REPLY_MESSAGE: string;
};

const COACH_MODULE_PATH: string = "./coach.ts";
const VOICE_MODULE_PATH: string = "./voice-commands.ts";
const coachModule: CoachModule = await import(COACH_MODULE_PATH);
const voiceModule: VoiceModule = await import(VOICE_MODULE_PATH);
const { parseVoiceCoachCommand, parseVoiceAssistantMessage } = voiceModule;
const parseCoachModelReply = coachModule.parseCoachModelReply;
const invalidCoachReplyMessage = coachModule.INVALID_COACH_REPLY_MESSAGE;

function testVoiceCommandParsing() {
  // Spoken numbers. Muse Voice Transcribe writes them as words, so these are the transcripts the
  // Coach actually receives; before this was handled they parsed to null and the command vanished
  // while the screen showed the phrase heard correctly.
  assert.deepEqual(parseVoiceCoachCommand("loop bars five to eight."), {
    name: "set_loop",
    args: { start_bar: 5, end_bar: 8 },
  });
  assert.deepEqual(parseVoiceCoachCommand("simplify bar six."), {
    name: "simplify_bar",
    args: { bar: 6 },
  });
  assert.deepEqual(parseVoiceCoachCommand("slow it down to sixty percent"), {
    name: "set_tempo",
    args: { percent: 60 },
  });
  assert.deepEqual(parseVoiceCoachCommand("slow it down to seventy five percent"), {
    name: "set_tempo",
    args: { percent: 75 },
  });

  // Loop range
  const loop1 = parseVoiceCoachCommand("loop bars 1 to 4");
  assert.deepEqual(loop1, {
    name: "set_loop",
    args: { start_bar: 1, end_bar: 4 },
  });

  const loop2 = parseVoiceCoachCommand("loop 5 - 8");
  assert.deepEqual(loop2, {
    name: "set_loop",
    args: { start_bar: 5, end_bar: 8 },
  });

  // Single bar loop
  const loopSingle = parseVoiceCoachCommand("loop bar 9");
  assert.deepEqual(loopSingle, {
    name: "set_loop",
    args: { start_bar: 8, end_bar: 11 },
  });

  // Tempo adjustment
  const tempo1 = parseVoiceCoachCommand("slow to 70%");
  assert.deepEqual(tempo1, {
    name: "set_tempo",
    args: { percent: 70 },
  });

  const tempo2 = parseVoiceCoachCommand("slow down");
  assert.deepEqual(tempo2, {
    name: "set_tempo",
    args: { percent: 75 },
  });

  // Hand isolation
  const leftHand = parseVoiceCoachCommand("isolate left hand please");
  assert.deepEqual(leftHand, {
    name: "switch_hand",
    args: { hand: "left" },
  });

  const rightHand = parseVoiceCoachCommand("right hand lead only");
  assert.deepEqual(rightHand, {
    name: "switch_hand",
    args: { hand: "right" },
  });

  const bothHands = parseVoiceCoachCommand("play both hands");
  assert.deepEqual(bothHands, {
    name: "switch_hand",
    args: { hand: "both" },
  });

  // Simplification
  const simplify = parseVoiceCoachCommand("simplify bar 9");
  assert.deepEqual(simplify, {
    name: "simplify_bar",
    args: { bar: 9 },
  });

  // Wake word stripping
  const wakeLoop = parseVoiceCoachCommand("hello mixray, loop bars 1 to 4");
  assert.deepEqual(wakeLoop, {
    name: "set_loop",
    args: { start_bar: 1, end_bar: 4 },
  });

  const wakeSlow = parseVoiceCoachCommand("hey mixray slow down");
  assert.deepEqual(wakeSlow, {
    name: "set_tempo",
    args: { percent: 75 },
  });

  const wakeSlowSpaced = parseVoiceCoachCommand("hey mix ray slow down");
  assert.deepEqual(wakeSlowSpaced, {
    name: "set_tempo",
    args: { percent: 75 },
  });

  const wakeSpeedUp = parseVoiceCoachCommand("hello mix-ray, speed up");
  assert.deepEqual(wakeSpeedUp, {
    name: "set_tempo",
    args: { percent: 100 },
  });

  // Empty or unhandled
  assert.equal(parseVoiceCoachCommand(""), null);
  assert.equal(parseVoiceCoachCommand("hello world"), null);

  console.log("PASS parseVoiceCoachCommand all phrase fixtures");
}

function testStubbedModelReplyValidation(): void {
  const lateBarReply: unknown = {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: "Bar 4 is consistently late. Slow down and isolate it." }],
      },
      {
        type: "function_call",
        name: "mark_problem_bar",
        arguments: '{"bar":4,"reason":"Repeated late note onsets"}',
      },
      {
        type: "function_call",
        name: "set_loop",
        arguments: '{"start_bar":3,"end_bar":5}',
      },
    ],
  };
  const lateBarResult = parseCoachModelReply(lateBarReply, 8);
  assert.equal(lateBarResult.actions.length, 2);
  assert.deepEqual(lateBarResult.actions[0], {
    name: "mark_problem_bar",
    args: { bar: 4, reason: "Repeated late note onsets" },
  });
  assert.deepEqual(lateBarResult.actions[1], {
    name: "set_loop",
    args: { start_bar: 3, end_bar: 5 },
  });

  const unknownToolReply: unknown = {
    output: [
      { type: "function_call", name: "invent_action", arguments: "{}" },
      { type: "function_call", name: "set_tempo", arguments: '{"percent":5}' },
    ],
  };
  const unknownToolResult = parseCoachModelReply(unknownToolReply, 8);
  assert.deepEqual(unknownToolResult.actions, [
    { name: "set_tempo", args: { percent: 40 } },
  ]);

  const outOfRangeBarReply: unknown = {
    output: [
      { type: "function_call", name: "simplify_bar", arguments: '{"bar":99}' },
    ],
  };
  const outOfRangeBarResult = parseCoachModelReply(outOfRangeBarReply, 8);
  assert.deepEqual(outOfRangeBarResult.actions, []);

  const reversedLoopReply: unknown = {
    output: [
      { type: "function_call", name: "set_loop", arguments: '{"start_bar":8,"end_bar":2}' },
    ],
  };
  const reversedLoopResult = parseCoachModelReply(reversedLoopReply, 8);
  assert.deepEqual(reversedLoopResult.actions, [
    { name: "set_loop", args: { start_bar: 2, end_bar: 8 } },
  ]);

  const malformedReply: unknown = { output: "not an output array" };
  const malformedResult = parseCoachModelReply(malformedReply, 8);
  assert.deepEqual(malformedResult, {
    message: invalidCoachReplyMessage,
    actions: [],
  });

  // Tool calls with no text still have to say what happened.
  const silent = parseCoachModelReply(
    {
      output: [
        { type: "function_call", name: "set_loop", arguments: '{"start_bar":2,"end_bar":2}' },
        { type: "function_call", name: "set_tempo", arguments: '{"percent":65}' },
      ],
    },
    8,
  );
  assert.equal(silent.message, "Looping bar 2. Tempo set to 65%.");

  // What the browser receives is the route's answer, not the model's raw reply.
  const routed = coachModule.parseCoachRouteReply(
    {
      message: "Bar 4 is late.",
      actions: [
        { name: "set_loop", args: { start_bar: 3, end_bar: 5 } },
        { name: "invent_action", args: {} },
        { name: "simplify_bar", args: { bar: 99 } },
      ],
    },
    8,
  );
  assert.deepEqual(routed, {
    message: "Bar 4 is late.",
    actions: [{ name: "set_loop", args: { start_bar: 3, end_bar: 5 } }],
  });
  assert.deepEqual(coachModule.parseCoachRouteReply({ message: "Send valid score.", actions: [] }, 8), {
    message: "Send valid score.",
    actions: [],
  });
  assert.equal(coachModule.parseCoachRouteReply({ output: [] }, 8).message, invalidCoachReplyMessage);

  console.log("PASS parseCoachModelReply stubbed-response fixtures");
}

function studioCommandOf(phrase: string): StudioCommand | null {
  const { intent } = parseVoiceAssistantMessage(phrase);
  return intent.kind === "studio" ? intent.command : null;
}

const STUDIO_PHRASES: readonly (readonly [string, StudioCommand])[] = [
  ["Play.", { name: "play" }],
  ["Resume", { name: "play" }],
  ["Stop.", { name: "pause" }],
  ["hold on", { name: "pause" }],
  ["hey mixray, pause", { name: "pause" }],
  ["From the top.", { name: "restart" }],
  ["Play it again", { name: "restart" }],
  ["Start over", { name: "restart" }],
  ["Go to bar five.", { name: "seek_bar", bar: 5 }],
  ["bar 12", { name: "seek_bar", bar: 12 }],
  ["Go to bar bar five.", { name: "seek_bar", bar: 5 }],
  ["Back two bars.", { name: "seek_relative", bars: -2 }],
  ["forward 4 bars", { name: "seek_relative", bars: 4 }],
  ["Next bar", { name: "seek_relative", bars: 1 }],
  ["previous bar", { name: "seek_relative", bars: -1 }],
  ["Loop this bar", { name: "loop_here", bars: 1 }],
  ["loop this this bar", { name: "loop_here", bars: 1 }],
  ["Loop these four bars", { name: "loop_here", bars: 4 }],
  ["Loop two bars", { name: "loop_here", bars: 2 }],
  ["Loop", { name: "loop_here", bars: 4 }],
  ["Loop off.", { name: "loop_off" }],
  ["Stop the loop", { name: "loop_off" }],
  ["Slower", { name: "tempo_step", delta: -10 }],
  // With music in the room the transcript loses the first sound of "slower".
  ["Lower.", { name: "tempo_step", delta: -10 }],
  ["Slow it down.", { name: "tempo_step", delta: -10 }],
  ["A little faster please", { name: "tempo_step", delta: 10 }],
  ["Speed up", { name: "tempo_step", delta: 10 }],
  ["Solo", { name: "monitor", stem: "sound" }],
  ["Just the sound", { name: "monitor", stem: "sound" }],
  ["The rest", { name: "monitor", stem: "rest" }],
  ["Backing track", { name: "monitor", stem: "rest" }],
  ["Full mix", { name: "monitor", stem: "mix" }],
  ["With the band", { name: "monitor", stem: "mix" }],
  ["Easy", { name: "level", level: "easy" }],
  ["Switch to intermediate", { name: "level", level: "intermediate" }],
  ["Switch to the bass", { name: "select_sound", sound: "bass" }],
  ["Listen to piano.", { name: "select_sound", sound: "piano" }],
  ["Go to analyze", { name: "go_to", screen: "xray" }],
  ["Open export", { name: "go_to", screen: "take" }],
  ["Go to the isolate screen", { name: "go_to", screen: "pick" }],
  ["Octave up", { name: "octave", delta: 1 }],
  ["Down an octave", { name: "octave", delta: -1 }],
  ["What is the key?", { name: "tell", fact: "key" }],
  ["What's the tempo", { name: "tell", fact: "tempo" }],
  ["Which bar is this", { name: "tell", fact: "bar" }],
  ["What can I say?", { name: "help" }],
];

function testStudioCommands(): void {
  for (const [phrase, expected] of STUDIO_PHRASES) {
    assert.deepEqual(studioCommandOf(phrase), expected, phrase);
  }
  console.log(`PASS studio commands, ${STUDIO_PHRASES.length} phrases`);
}

function testPhrasesThatStayWithTheCoachTools(): void {
  const actionOf = (phrase: string): CoachAction | null => {
    const { intent } = parseVoiceAssistantMessage(phrase);
    return intent.kind === "action" ? intent.action : null;
  };
  assert.deepEqual(actionOf("Loop four to eight."), { name: "set_loop", args: { start_bar: 4, end_bar: 8 } });
  assert.deepEqual(actionOf("Loop bars 5 to 8"), { name: "set_loop", args: { start_bar: 5, end_bar: 8 } });
  assert.deepEqual(actionOf("Slow down to 70%."), { name: "set_tempo", args: { percent: 70 } });
  assert.deepEqual(actionOf("Half speed"), { name: "set_tempo", args: { percent: 50 } });
  assert.deepEqual(actionOf("Normal speed"), { name: "set_tempo", args: { percent: 100 } });
  assert.deepEqual(actionOf("Switch to normal speed"), { name: "set_tempo", args: { percent: 100 } });
  assert.deepEqual(actionOf("Use both hands"), { name: "switch_hand", args: { hand: "both" } });
  assert.deepEqual(actionOf("Practice left hand"), { name: "switch_hand", args: { hand: "left" } });
  assert.deepEqual(actionOf("Simplify bar six"), { name: "simplify_bar", args: { bar: 6 } });

  assert.equal(parseVoiceAssistantMessage("How did I do?").intent.kind, "analyze");
  assert.equal(parseVoiceAssistantMessage("Analyze my take").intent.kind, "analyze");
  assert.equal(parseVoiceAssistantMessage("Reset").intent.kind, "reset");
  assert.equal(parseVoiceAssistantMessage("Reset everything").intent.kind, "reset");
  assert.equal(parseVoiceAssistantMessage("Hey mixray").intent.kind, "greeting");
  assert.equal(parseVoiceAssistantMessage("The weather is nice today").intent.kind, "unknown");
  console.log("PASS phrases that stay with the Coach tools");
}

testVoiceCommandParsing();
testStudioCommands();
testPhrasesThatStayWithTheCoachTools();
testStubbedModelReplyValidation();
console.log("All coach fixtures passed.");

