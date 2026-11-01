import type { ScoreInput, ScoreNote, ScoreResult } from "./score";
import type { CompletedNote, ControlKind, LiveNoteEvent, NoteStream, TalkBinding, TalkControlOptions } from "./midi";

type FixtureCase = {
  name: string;
  run: () => void;
};

type MidiModule = {
  parseMidiBytes: (
    bytes: Uint8Array | readonly number[],
    clockSeconds: number,
    deviceId?: string,
  ) => LiveNoteEvent | null;
  createNoteStream: (
    clock: () => number,
    options?: { selectedDeviceId?: string; defaultVelocity?: number },
  ) => NoteStream;
  classifyControl: (bytes: readonly number[], binding: TalkBinding) => ControlKind;
  createTalkControl: (options: TalkControlOptions) => (bytes: readonly number[]) => boolean;
};

type ScoreModule = {
  scorePerformance: (input: ScoreInput) => ScoreResult;
};

const MIDI_MODULE_PATH: string = "./midi.ts";
const SCORE_MODULE_PATH: string = "./score.ts";

const midiModule: MidiModule = await import(MIDI_MODULE_PATH);
const scoreModule: ScoreModule = await import(SCORE_MODULE_PATH);
const { classifyControl, createTalkControl } = midiModule;

const parseMidiBytes = midiModule.parseMidiBytes;
const createNoteStream = midiModule.createNoteStream;
const scorePerformance = scoreModule.scorePerformance;

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

function testParseMidiBytes(): void {
  // 1. Standard Note On (channel 1, pitch 60, velocity 100) at 1.25s
  const noteOn = parseMidiBytes([0x90, 60, 100], 1.25, "dev-1");
  assertEqual(noteOn?.kind, "note_on", "Note On kind");
  assertEqual(noteOn?.pitch, 60, "Note On pitch");
  assertEqual(noteOn?.velocity, 100, "Note On velocity");
  assertClose(noteOn?.onsetSeconds ?? null, 1.25, "Note On timestamp");
  assertEqual(noteOn?.deviceId, "dev-1", "Note On deviceId");

  // 2. Note On with velocity 0 treated as Note Off
  const noteZero = parseMidiBytes([0x90, 60, 0], 2.0);
  assertEqual(noteZero?.kind, "note_off", "Note On v=0 kind");
  assertEqual(noteZero?.pitch, 60, "Note On v=0 pitch");
  assertEqual(noteZero?.velocity, 0, "Note On v=0 velocity");

  // 3. Standard Note Off (0x80)
  const noteOff = parseMidiBytes([0x80, 64, 64], 3.14);
  assertEqual(noteOff?.kind, "note_off", "Note Off kind");
  assertEqual(noteOff?.pitch, 64, "Note Off pitch");

  // 4. Non-note status (e.g. CC 0xB0 or Pitch Bend 0xE0) ignored
  const ccMsg = parseMidiBytes([0xb0, 7, 100], 1.0);
  assertEqual(ccMsg, null, "CC message ignored");

  // 5. Incomplete byte sequence
  const shortMsg = parseMidiBytes([0x90, 60], 1.0);
  assertEqual(shortMsg, null, "Short message ignored");
}

function testNoteStreamLiveEvents(): void {
  let simulatedClock = 0.5;
  const stream = createNoteStream(() => simulatedClock);

  const receivedEvents: LiveNoteEvent[] = [];
  const unsubscribe = stream.subscribe((event) => {
    receivedEvents.push(event);
  });

  // Emit on-screen note
  stream.emitNoteOn(60, 90, "screen");
  assertEqual(receivedEvents.length, 1, "First event received");
  assertEqual(receivedEvents[0]?.kind, "note_on", "Kind is note_on");
  assertEqual(receivedEvents[0]?.source, "screen", "Source is screen");
  assertClose(receivedEvents[0]?.onsetSeconds ?? null, 0.5, "Clock timestamp 0.5");

  // Advance clock and feed Web MIDI bytes
  simulatedClock = 1.2;
  const fed = stream.feedMidiBytes([0x90, 67, 110], "keyboard-1");
  assertEqual(fed !== null, true, "Fed MIDI parsed");
  assertEqual(receivedEvents.length, 2, "Second event received");
  assertEqual(receivedEvents[1]?.kind, "note_on", "Web MIDI note on");
  assertEqual(receivedEvents[1]?.pitch, 67, "Pitch 67");
  assertEqual(receivedEvents[1]?.source, "web_midi", "Source is web_midi");
  assertClose(receivedEvents[1]?.onsetSeconds ?? null, 1.2, "Clock timestamp 1.2");

  // Advance clock and release
  simulatedClock = 1.6;
  stream.feedMidiBytes([0x80, 67, 0], "keyboard-1");
  assertEqual(receivedEvents.length, 3, "Third event received");
  assertEqual(receivedEvents[2]?.kind, "note_off", "Web MIDI note off");

  // Unsubscribe stops notifications
  unsubscribe();
  stream.emitNoteOn(72, 80, "qwerty");
  assertEqual(receivedEvents.length, 3, "No event received after unsubscribe");

  stream.dispose();
}

function testTakeRecordingAndScoring(): void {
  let simulatedClock = 0.0;
  const stream = createNoteStream(() => simulatedClock);

  stream.startRecording();
  assertEqual(stream.isRecording(), true, "Recording is active");

  // Play note 1 at 0.5s (C4 = 60)
  simulatedClock = 0.5;
  stream.emitNoteOn(60, 96, "screen");
  simulatedClock = 0.7;
  stream.emitNoteOff(60, "screen");

  // Play note 2 at 1.0s (D4 = 62) via MIDI
  simulatedClock = 1.0;
  stream.feedMidiBytes([0x90, 62, 100]);
  simulatedClock = 1.25;
  stream.feedMidiBytes([0x80, 62, 0]);

  // Play note 3 at 1.52s (E4 = 64) via QWERTY (20ms offset, well within 50ms on-time window)
  simulatedClock = 1.52;
  stream.emitNoteOn(64, 88, "qwerty");
  simulatedClock = 1.8;
  stream.emitNoteOff(64, "qwerty");

  const recordedTake: ScoreNote[] = stream.stopRecording();
  assertEqual(stream.isRecording(), false, "Recording stopped");
  assertEqual(recordedTake.length, 3, "Recorded 3 notes");

  assertEqual(recordedTake[0]?.pitch, 60, "Note 1 pitch");
  assertClose(recordedTake[0]?.onsetSeconds ?? null, 0.5, "Note 1 onset");
  assertEqual(recordedTake[1]?.pitch, 62, "Note 2 pitch");
  assertClose(recordedTake[1]?.onsetSeconds ?? null, 1.0, "Note 2 onset");
  assertEqual(recordedTake[2]?.pitch, 64, "Note 3 pitch");
  assertClose(recordedTake[2]?.onsetSeconds ?? null, 1.52, "Note 3 onset");

  // Check completed notes with durations
  const completed: CompletedNote[] = stream.getCompletedNotes();
  assertEqual(completed.length, 3, "Completed 3 notes");
  assertClose(completed[0]?.durationSeconds ?? null, 0.2, "Note 1 duration 0.2s");
  assertClose(completed[1]?.durationSeconds ?? null, 0.25, "Note 2 duration 0.25s");

  // Integrate recorded take directly into scorePerformance
  const referenceNotes: ScoreNote[] = [
    { onsetSeconds: 0.5, pitch: 60 },
    { onsetSeconds: 1.0, pitch: 62 },
    { onsetSeconds: 1.5, pitch: 64 },
  ];

  const scoreResult = scorePerformance({
    referenceNotes,
    playedNotes: recordedTake,
    downbeats: [0.0, 2.0],
    durationSeconds: 4.0,
  });

  assertEqual(scoreResult.bars.length, 2, "2 score bars");
  const bar0 = scoreResult.bars[0];
  assertEqual(bar0?.attempted, true, "Bar 0 attempted");
  assertEqual(bar0?.hitRate, 1, "Bar 0 100% hit rate");
  assertEqual(bar0?.onTimeRate, 1, "Bar 0 100% on time rate");
  assertEqual(bar0?.missed, 0, "Bar 0 0 missed");
  assertEqual(bar0?.wrongPitch, 0, "Bar 0 0 wrong pitch");

  stream.dispose();
}

function testTalkControl(): void {
  const PEDAL_DOWN = [0xb0, 64, 127];
  const PEDAL_UP = [0xb0, 64, 0];
  const PAD_ON = [0x99, 36, 100];
  const PAD_OFF = [0x89, 36, 0];
  const KEY_ON = [0x90, 60, 100];
  const MOD_WHEEL = [0xb0, 1, 90];

  let presses = 0;
  let binding: TalkBinding = { kind: "default" };
  let learning = false;
  const handle = createTalkControl({
    getBinding: () => binding,
    isLearning: () => learning,
    onPress: () => {
      presses += 1;
    },
    onLearned: (chosen) => {
      binding = chosen;
      learning = false;
    },
  });

  assertEqual(handle(KEY_ON), false, "A keyboard note is music");
  assertEqual(handle(MOD_WHEEL), false, "Other controls are left alone");
  assertEqual(presses, 0, "Music never presses the talk button");

  assertEqual(handle(PEDAL_DOWN), true, "The pedal is a control");
  assertEqual(handle([0xb0, 64, 100]), true, "A pedal still going down is a control");
  assertEqual(presses, 1, "A pedal travelling down counts once");
  assertEqual(handle(PEDAL_UP), true, "Releasing the pedal is a control");
  assertEqual(presses, 1, "Releasing does not press");

  assertEqual(handle(PAD_ON), true, "A pad is never a played note");
  assertEqual(handle(PAD_OFF), true, "Releasing a pad is never a played note");
  assertEqual(presses, 2, "A pad presses the talk button");

  learning = true;
  assertEqual(handle([0xb0, 115, 0]), true, "Learning swallows a released button");
  assertEqual(binding.kind, "default", "A released button is not chosen");
  assertEqual(handle([0xb0, 115, 127]), true, "Learning swallows the chosen button");
  assertEqual(binding.kind, "cc", "The chosen button is remembered");
  assertEqual(presses, 2, "Choosing a button does not press it");
  assertEqual(handle([0xb0, 115, 0]), true, "Its release is consumed");

  assertEqual(handle(PEDAL_DOWN), false, "The pedal is free once another button is chosen");
  assertEqual(handle(PAD_ON), true, "Pads still never score as notes");
  assertEqual(presses, 2, "A pad no longer talks once another button is chosen");
  assertEqual(handle(PAD_OFF), true, "Its release neither");
  assertEqual(handle([0xb0, 115, 127]), true, "The chosen button is a control");
  assertEqual(presses, 3, "The chosen button talks");

  assertEqual(classifyControl([0x99, 40, 90], { kind: "note", channel: 9, pitch: 40 }), "press", "A chosen pad");
  assertEqual(classifyControl([0x90, 60, 90], { kind: "note", channel: 0, pitch: 60 }), "press", "A chosen key");
  assertEqual(classifyControl([0x90, 62, 90], { kind: "note", channel: 0, pitch: 60 }), "pass", "Any other key");
  assertEqual(classifyControl([0x90, 60, 0], { kind: "note", channel: 0, pitch: 60 }), "consume", "Its release");
}

const FIXTURES: readonly FixtureCase[] = [
  { name: "parseMidiBytes message decoding and clamping", run: testParseMidiBytes },
  { name: "createNoteStream live event routing and subscriptions", run: testNoteStreamLiveEvents },
  { name: "take recording aligned to audio clock and score integration", run: testTakeRecordingAndScoring },
  { name: "talk button from pedal, pads and a chosen control", run: testTalkControl },
];

for (const fixture of FIXTURES) {
  fixture.run();
  console.log(`PASS ${fixture.name}`);
}

console.log("All MIDI fixtures passed.");
