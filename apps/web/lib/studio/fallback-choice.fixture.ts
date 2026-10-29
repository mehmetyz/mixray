import assert from "node:assert/strict";
import type { FallbackStem, Isolation } from "../trackmap/trackmap.generated";
import type { PitchConfidenceComparison } from "./fallback-choice";

type CompareFunction = (
  isolation: Isolation | undefined,
  fallbackStem: FallbackStem | null,
  allIsolations?: readonly Isolation[],
) => PitchConfidenceComparison | null;

type ModuleType = {
  compareStemPitchConfidence: CompareFunction;
};

const MODULE_PATH = "./fallback-choice.ts";
const loadedModule: ModuleType = await import(MODULE_PATH);
const compareStemPitchConfidence = loadedModule.compareStemPitchConfidence;

function testPitchConfidenceComparison() {
  const samPianoIso: Isolation = {
    id: "sam-piano-1",
    label: "Piano lead",
    prompt: "piano chords",
    method: "sam_audio_text",
    sound_url: "/files/piano-sam.mp3",
    rest_url: "/files/piano-sam-rest.mp3",
    peaks: [0.1, 0.2],
    pitch_confidence: 0.76,
    range: { low: 60, high: 84 },
    notes: [],
    arrangements: { easy: [] },
  };

  const demucsPianoIso: Isolation = {
    id: "demucs-piano-1",
    label: "Piano stem",
    prompt: "piano chords",
    method: "demucs",
    sound_url: "/files/piano-demucs.mp3",
    rest_url: "/files/piano-demucs-rest.mp3",
    peaks: [0.15, 0.25],
    pitch_confidence: 0.91,
    range: { low: 60, high: 84 },
    notes: [],
    arrangements: { easy: [] },
  };

  const fallbackPianoStem: FallbackStem = {
    name: "piano",
    url: "/files/piano.mp3",
    level: 0.8,
  };

  // Case 1: Demucs has higher confidence -> demucs should be preferred
  const comp1 = compareStemPitchConfidence(samPianoIso, fallbackPianoStem, [
    samPianoIso,
    demucsPianoIso,
  ]);
  assert.notEqual(comp1, null);
  assert.equal(comp1?.hasComparison, true);
  assert.equal(comp1?.preferredMethod, "demucs");
  assert.equal(comp1?.samConfidence, 0.76);
  assert.equal(comp1?.demucsConfidence, 0.91);
  assert.equal(comp1?.confidenceDelta, 0.15);

  // Case 2: SAM Audio has higher confidence -> sam_audio should be preferred
  const samBetterIso: Isolation = {
    ...samPianoIso,
    pitch_confidence: 0.95,
  };
  const comp2 = compareStemPitchConfidence(samBetterIso, fallbackPianoStem, [
    samBetterIso,
    demucsPianoIso,
  ]);
  assert.notEqual(comp2, null);
  assert.equal(comp2?.preferredMethod, "sam_audio");
  assert.equal(comp2?.confidenceDelta, 0.04);

  // Case 3: No demucs isolation in trackmap -> fallback hasComparison false
  const comp3 = compareStemPitchConfidence(samPianoIso, fallbackPianoStem, [samPianoIso]);
  assert.notEqual(comp3, null);
  assert.equal(comp3?.hasComparison, false);
  assert.equal(comp3?.preferredMethod, "sam_audio");

  // Case 4: Undefined isolation or fallbackStem
  assert.equal(compareStemPitchConfidence(undefined, fallbackPianoStem), null);
  assert.equal(compareStemPitchConfidence(samPianoIso, null), null);

  console.log("PASS testPitchConfidenceComparison all cases");
}

testPitchConfidenceComparison();
console.log("All fallback choice fixtures passed.");

