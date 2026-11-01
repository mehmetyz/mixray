export type TakeNote = {
  time: number;
  pitch: number;
};

const REWIND_SECONDS = 0.25;
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
