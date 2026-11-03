export type ScoreNote = {
  onsetSeconds: number;
  pitch: number;
};

export type ScoreInput = {
  referenceNotes: ScoreNote[];
  playedNotes: ScoreNote[];
  downbeats: number[];
  durationSeconds: number;
};

export type ScoreTiming = "on_time" | "early" | "late";

export type ScoreMatch = {
  referenceIndex: number;
  playedIndex: number;
  offsetMs: number;
  timing: ScoreTiming;
};

export type ScoreBar = {
  index: number;
  startSeconds: number;
  endSeconds: number;
  attempted: boolean;
  hitRate: number;
  onTimeRate: number;
  meanOffsetMs: number | null;
  missed: number;
  extra: number;
  wrongPitch: number;
};

export type ScoreResult = {
  bars: ScoreBar[];
  matches: ScoreMatch[];
};

type BarRange = {
  index: number;
  startSeconds: number;
  endSeconds: number;
};

type BarAccumulator = {
  attempted: boolean;
  referenceCount: number;
  matchedCount: number;
  onTimeCount: number;
  offsetTotalMs: number;
  missed: number;
  extra: number;
  wrongPitch: number;
};

type IndexedScoreNote = {
  index: number;
  note: ScoreNote;
};

const ON_TIME_WINDOW_MS = 50;
const MATCH_WINDOW_MS = 120;

function offsetMs(played: ScoreNote, reference: ScoreNote): number {
  return (played.onsetSeconds - reference.onsetSeconds) * 1000;
}

function createBarRanges(downbeats: number[], durationSeconds: number): BarRange[] {
  const ranges: BarRange[] = [];

  for (let index = 0; index < downbeats.length; index += 1) {
    const startSeconds = downbeats[index];
    if (startSeconds === undefined) continue;
    const endSeconds = downbeats[index + 1] ?? durationSeconds;
    if (endSeconds <= startSeconds) continue;
    // A clip rarely starts exactly on a bar line, and the notes before the first one still count.
    ranges.push({ index, startSeconds: ranges.length === 0 ? 0 : startSeconds, endSeconds });
  }

  return ranges;
}

export function findScoreBarIndex(
  onsetSeconds: number,
  downbeats: number[],
  durationSeconds: number,
): number | null {
  const ranges = createBarRanges(downbeats, durationSeconds);
  for (const range of ranges) {
    if (onsetSeconds >= range.startSeconds && onsetSeconds < range.endSeconds) {
      return range.index;
    }
  }
  return null;
}

function createAccumulators(ranges: BarRange[]): BarAccumulator[] {
  return ranges.map(() => ({
    attempted: false,
    referenceCount: 0,
    matchedCount: 0,
    onTimeCount: 0,
    offsetTotalMs: 0,
    missed: 0,
    extra: 0,
    wrongPitch: 0,
  }));
}

function isWithinMatchWindow(offsetMilliseconds: number): boolean {
  return Math.abs(offsetMilliseconds) <= MATCH_WINDOW_MS;
}

function timingForOffset(offsetMilliseconds: number): ScoreTiming {
  if (Math.abs(offsetMilliseconds) <= ON_TIME_WINDOW_MS) return "on_time";
  return offsetMilliseconds < 0 ? "early" : "late";
}

function chooseNearestMatch(
  played: ScoreNote,
  references: IndexedScoreNote[],
  usedReferenceIndexes: Set<number>,
): IndexedScoreNote | null {
  let nearest: IndexedScoreNote | null = null;
  let nearestDistanceMs = Infinity;

  for (const reference of references) {
    if (usedReferenceIndexes.has(reference.index) || reference.note.pitch !== played.pitch) {
      continue;
    }
    const distanceMs = Math.abs(offsetMs(played, reference.note));
    if (
      distanceMs <= MATCH_WINDOW_MS &&
      (distanceMs < nearestDistanceMs ||
        (distanceMs === nearestDistanceMs &&
          (nearest === null || reference.index < nearest.index)))
    ) {
      nearest = reference;
      nearestDistanceMs = distanceMs;
    }
  }

  return nearest;
}

function hasReferenceWithDifferentPitchInWindow(
  played: ScoreNote,
  references: IndexedScoreNote[],
): boolean {
  for (const reference of references) {
    if (
      reference.note.pitch !== played.pitch &&
      isWithinMatchWindow(offsetMs(played, reference.note))
    ) {
      return true;
    }
  }
  return false;
}

function hasReferenceWithSamePitchInWindow(
  played: ScoreNote,
  references: IndexedScoreNote[],
): boolean {
  for (const reference of references) {
    if (
      reference.note.pitch === played.pitch &&
      isWithinMatchWindow(offsetMs(played, reference.note))
    ) {
      return true;
    }
  }
  return false;
}

function toScoreBars(ranges: BarRange[], accumulators: BarAccumulator[]): ScoreBar[] {
  return ranges.map((range, rangePosition) => {
    const accumulator = accumulators[rangePosition];
    if (accumulator === undefined) {
      return {
        index: range.index,
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
        attempted: false,
        hitRate: 0,
        onTimeRate: 0,
        meanOffsetMs: null,
        missed: 0,
        extra: 0,
        wrongPitch: 0,
      };
    }
    const referenceCount = accumulator.referenceCount;
    const matchCount = accumulator.matchedCount;
    return {
      index: range.index,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds,
      attempted: accumulator.attempted,
      hitRate: referenceCount === 0 ? 0 : matchCount / referenceCount,
      onTimeRate: referenceCount === 0 ? 0 : accumulator.onTimeCount / referenceCount,
      meanOffsetMs: matchCount === 0 ? null : accumulator.offsetTotalMs / matchCount,
      missed: accumulator.missed,
      extra: accumulator.extra,
      wrongPitch: accumulator.wrongPitch,
    };
  });
}

/**
 * The notes the take can be judged on at `time`: those whose window has passed, and those already
 * played. A note still ahead of the playhead is not a miss yet, and counting it as one made the
 * score start low and climb while someone played every note right.
 */
export function reachedNotes(
  reference: readonly ScoreNote[],
  played: readonly ScoreNote[],
  time: number,
): ScoreNote[] {
  const window = MATCH_WINDOW_MS / 1000;
  return reference.filter(
    (note) =>
      note.onsetSeconds + window <= time ||
      played.some((dot) => dot.pitch === note.pitch && Math.abs(dot.onsetSeconds - note.onsetSeconds) <= window),
  );
}

export function scorePerformance(input: ScoreInput): ScoreResult {
  const ranges = createBarRanges(input.downbeats, input.durationSeconds);
  const accumulators = createAccumulators(ranges);
  const referenceBarIndexes = input.referenceNotes.map((note) =>
    findScoreBarIndex(note.onsetSeconds, input.downbeats, input.durationSeconds),
  );
  const playedBarIndexes = input.playedNotes.map((note) =>
    findScoreBarIndex(note.onsetSeconds, input.downbeats, input.durationSeconds),
  );
  const references: IndexedScoreNote[] = input.referenceNotes.map((note, index) => ({ index, note }));
  const played: IndexedScoreNote[] = input.playedNotes
    .map((note, index) => ({ index, note }))
    .sort((left, right) => left.note.onsetSeconds - right.note.onsetSeconds || left.index - right.index);
  const usedReferenceIndexes = new Set<number>();
  const matchedPlayedIndexes = new Set<number>();
  const matches: ScoreMatch[] = [];

  for (let index = 0; index < referenceBarIndexes.length; index += 1) {
    const barIndex = referenceBarIndexes[index] ?? null;
    if (barIndex === null) continue;
    const accumulator = accumulators[barIndex];
    if (accumulator !== undefined) accumulator.referenceCount += 1;
  }

  for (let index = 0; index < playedBarIndexes.length; index += 1) {
    const barIndex = playedBarIndexes[index] ?? null;
    if (barIndex === null) continue;
    const accumulator = accumulators[barIndex];
    if (accumulator !== undefined) accumulator.attempted = true;
  }

  for (const playedNote of played) {
    const reference = chooseNearestMatch(playedNote.note, references, usedReferenceIndexes);
    if (reference === null) continue;

    const playedOffsetMs = offsetMs(playedNote.note, reference.note);
    const referenceBarIndex = referenceBarIndexes[reference.index] ?? null;
    usedReferenceIndexes.add(reference.index);
    matchedPlayedIndexes.add(playedNote.index);
    matches.push({
      referenceIndex: reference.index,
      playedIndex: playedNote.index,
      offsetMs: playedOffsetMs,
      timing: timingForOffset(playedOffsetMs),
    });

    if (referenceBarIndex === null) continue;
    const accumulator = accumulators[referenceBarIndex];
    if (accumulator === undefined) continue;
    accumulator.matchedCount += 1;
    accumulator.offsetTotalMs += playedOffsetMs;
    if (Math.abs(playedOffsetMs) <= ON_TIME_WINDOW_MS) accumulator.onTimeCount += 1;
  }

  for (let index = 0; index < referenceBarIndexes.length; index += 1) {
    if (usedReferenceIndexes.has(index)) continue;
    const barIndex = referenceBarIndexes[index] ?? null;
    if (barIndex === null) continue;
    const accumulator = accumulators[barIndex];
    if (accumulator !== undefined) accumulator.missed += 1;
  }

  for (const playedNote of played) {
    if (matchedPlayedIndexes.has(playedNote.index)) continue;
    const barIndex = playedBarIndexes[playedNote.index] ?? null;
    if (barIndex === null) continue;
    const accumulator = accumulators[barIndex];
    if (accumulator === undefined) continue;
    if (
      hasReferenceWithDifferentPitchInWindow(playedNote.note, references) &&
      !hasReferenceWithSamePitchInWindow(playedNote.note, references)
    ) {
      accumulator.wrongPitch += 1;
    } else {
      accumulator.extra += 1;
    }
  }

  return { bars: toScoreBars(ranges, accumulators), matches };
}
