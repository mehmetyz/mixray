import type { ScoreBar, ScoreInput, ScoreNote, ScoreResult } from "./score";

type FixtureCase = {
  name: string;
  run: () => void;
};

type ScorePerformance = (input: ScoreInput) => ScoreResult;

type ScoreModule = {
  scorePerformance: ScorePerformance;
};

const SCORE_MODULE_PATH: string = "./score.ts";
const scoreModule: ScoreModule = await import(SCORE_MODULE_PATH);
const scorePerformance: ScorePerformance = scoreModule.scorePerformance;

const REFERENCE_ON_TIME: ScoreNote = { onsetSeconds: 0.5, pitch: 60 };
const REFERENCE_EARLY: ScoreNote = { onsetSeconds: 1, pitch: 62 };
const REFERENCE_LATE: ScoreNote = { onsetSeconds: 1.5, pitch: 64 };
const REFERENCE_WRONG_PITCH: ScoreNote = { onsetSeconds: 2, pitch: 65 };
const REFERENCE_MISSED: ScoreNote = { onsetSeconds: 2.5, pitch: 67 };
const PLAYED_ON_TIME: ScoreNote = { onsetSeconds: 0.52, pitch: 60 };
const PLAYED_EARLY: ScoreNote = { onsetSeconds: 0.91, pitch: 62 };
const PLAYED_LATE: ScoreNote = { onsetSeconds: 1.58, pitch: 64 };
const PLAYED_WRONG_PITCH: ScoreNote = { onsetSeconds: 2, pitch: 66 };
const PLAYED_EXTRA: ScoreNote = { onsetSeconds: 2.8, pitch: 69 };

const FULL_INPUT: ScoreInput = {
  referenceNotes: [
    REFERENCE_ON_TIME,
    REFERENCE_EARLY,
    REFERENCE_LATE,
    REFERENCE_WRONG_PITCH,
    REFERENCE_MISSED,
  ],
  playedNotes: [PLAYED_ON_TIME, PLAYED_EARLY, PLAYED_LATE, PLAYED_WRONG_PITCH, PLAYED_EXTRA],
  downbeats: [0, 3, 6],
  durationSeconds: 9,
};

const EMPTY_INPUT: ScoreInput = {
  referenceNotes: [],
  playedNotes: [],
  downbeats: [0, 3],
  durationSeconds: 6,
};

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function assertClose(actual: number | null, expected: number, message: string): void {
  if (actual === null || Math.abs(actual - expected) > 0.000001) {
    throw new Error(`${message}: expected ${expected}, received ${String(actual)}`);
  }
}

function firstBar(result: ScoreResult): ScoreBar {
  const bar = result.bars[0];
  if (bar === undefined) throw new Error("Expected first scored bar");
  return bar;
}

function fullTakeCase(): void {
  const result = scorePerformance(FULL_INPUT);
  const bar = firstBar(result);

  assertEqual(result.matches.length, 3, "on-time, early, and late notes should match");
  assertEqual(bar.attempted, true, "played bar should be attempted");
  assertEqual(bar.hitRate, 3 / 5, "hit rate should include matched reference notes");
  assertEqual(bar.onTimeRate, 1 / 5, "on-time rate should only include on-time matches");
  assertClose(bar.meanOffsetMs, 10 / 3, "mean offset should be signed across matches");
  assertEqual(bar.missed, 2, "wrong-pitch and unplayed references should be missed");
  assertEqual(bar.wrongPitch, 1, "in-window different pitch should be wrong pitch");
  assertEqual(bar.extra, 1, "out-of-window note should be extra");
  assertEqual(result.matches[0]?.timing, "on_time", "first match should be on time");
  assertEqual(result.matches[1]?.timing, "early", "second match should be early");
  assertEqual(result.matches[2]?.timing, "late", "third match should be late");
}

function unattemptedBarCase(): void {
  const result = scorePerformance(FULL_INPUT);
  const bar = result.bars[1];
  if (bar === undefined) throw new Error("Expected second scored bar");
  assertEqual(bar.attempted, false, "bar without played notes should not be attempted");
  assertEqual(bar.hitRate, 0, "unattempted bar should not have an invented hit rate");
  assertEqual(bar.onTimeRate, 0, "unattempted bar should not have an invented on-time rate");
  assertEqual(bar.meanOffsetMs, null, "unattempted bar should not have an offset");
}

function emptyInputCase(): void {
  const result = scorePerformance(EMPTY_INPUT);
  assertEqual(result.matches.length, 0, "empty input should have no matches");
  assertEqual(result.bars.length, 2, "downbeats should define both bars including the last bar");
  for (const bar of result.bars) {
    assertEqual(bar.attempted, false, "empty input bars should not be attempted");
    assertEqual(bar.missed, 0, "empty input bars should have no misses");
    assertEqual(bar.extra, 0, "empty input bars should have no extras");
    assertEqual(bar.wrongPitch, 0, "empty input bars should have no wrong pitches");
  }
}

const CASES: FixtureCase[] = [
  { name: "full take", run: fullTakeCase },
  { name: "unattempted bar", run: unattemptedBarCase },
  { name: "empty input", run: emptyInputCase },
];

let failures = 0;
for (const fixture of CASES) {
  try {
    fixture.run();
    console.log(`PASS ${fixture.name}`);
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`FAIL ${fixture.name}: ${message}`);
  }
}

if (failures > 0) {
  process.exitCode = 1;
} else {
  console.log("All score fixtures passed.");
}
