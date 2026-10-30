import assert from "node:assert/strict";
import type { CoachAction, CoachReply } from "./coach";

type ParseVoiceCoachCommand = (phrase: string) => CoachAction | null;

type CoachModule = {
  parseVoiceCoachCommand: ParseVoiceCoachCommand;
  parseCoachModelReply: (reply: unknown, barCount: number) => CoachReply;
  INVALID_COACH_REPLY_MESSAGE: string;
};

const COACH_MODULE_PATH: string = "./coach.ts";
const coachModule: CoachModule = await import(COACH_MODULE_PATH);
const parseVoiceCoachCommand: ParseVoiceCoachCommand = coachModule.parseVoiceCoachCommand;
const parseCoachModelReply = coachModule.parseCoachModelReply;
const invalidCoachReplyMessage = coachModule.INVALID_COACH_REPLY_MESSAGE;

function testVoiceCommandParsing() {
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

  console.log("PASS parseCoachModelReply stubbed-response fixtures");
}

testVoiceCommandParsing();
testStubbedModelReplyValidation();
console.log("All coach fixtures passed.");

