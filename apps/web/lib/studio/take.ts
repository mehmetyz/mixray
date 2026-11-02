export type TakeNote = {
  time: number;
  pitch: number;
};

/** A note in a take, and which time through the clip it was played on. */
export type PassedNote = TakeNote & {
  pass: number;
};

export const REWIND_SECONDS = 0.25;
// Less than this backwards is clock jitter, not the playhead going back.
const NEW_PASS_MIN_REWIND_SECONDS = 0.05;
// More than this forwards is a seek, and what a seek skips was not played over.
const MAX_TICK_SECONDS = 1;
const MAX_TAKE_NOTES = 4000;

/**
 * Adds a played note, keeping only the latest pass over each moment of the clip. Without this a second
 * time through a loop would be scored together with the first, and old notes would count as hits.
 */
export function addToTake<Dot extends TakeNote>(take: readonly Dot[], dot: Dot): Dot[] {
  const previous = take[take.length - 1];
  const from = previous !== undefined && dot.time > previous.time ? previous.time : dot.time - REWIND_SECONDS;
  const kept = take.filter((note) => note === previous || note.time <= from || note.time > dot.time);
  return [...kept, dot].slice(-MAX_TAKE_NOTES);
}

export function startsNewPass(from: number, to: number): boolean {
  return to < from - NEW_PASS_MIN_REWIND_SECONDS;
}

/** Silence counts too: as the playhead crosses a moment again, whatever an earlier pass left there goes. */
export function forgetPassed<Dot extends PassedNote>(take: Dot[], from: number, to: number, pass: number): Dot[] {
  if (to <= from || to - from > MAX_TICK_SECONDS) return take;
  const kept = take.filter((note) => note.pass === pass || note.time <= from || note.time > to);
  return kept.length === take.length ? take : kept;
}
