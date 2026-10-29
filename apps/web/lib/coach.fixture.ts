import assert from "node:assert/strict";
import type { CoachAction } from "./coach";

type ParseVoiceCoachCommand = (phrase: string) => CoachAction | null;

type CoachModule = {
  parseVoiceCoachCommand: ParseVoiceCoachCommand;
};

const COACH_MODULE_PATH: string = "./coach.ts";
const coachModule: CoachModule = await import(COACH_MODULE_PATH);
const parseVoiceCoachCommand: ParseVoiceCoachCommand = coachModule.parseVoiceCoachCommand;

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

testVoiceCommandParsing();
console.log("All coach fixtures passed.");

