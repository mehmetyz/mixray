export const MAX_CLIP_SECONDS = 30;

/** The part of a file the user chose to work on. Always inside the file and never over the cap. */
export type ClipWindow = {
  start: number;
  end: number;
};

export type ClipWindowRequest = {
  start: number;
  duration: number;
  fileDuration: number;
};

export class InvalidClipError extends Error {
  override name = "InvalidClipError";
}

/** Clamps a requested window into the file and down to the cap, keeping the start the user picked. */
export function clipWindow({ start, duration, fileDuration }: ClipWindowRequest): ClipWindow {
  if (!Number.isFinite(fileDuration) || fileDuration <= 0) {
    throw new InvalidClipError("The file has no readable duration.");
  }
  if (!Number.isFinite(start) || !Number.isFinite(duration)) {
    throw new InvalidClipError("The clip start and length must be numbers.");
  }

  const wanted = Math.min(Math.max(duration, 0), MAX_CLIP_SECONDS);
  const longest = Math.min(fileDuration, MAX_CLIP_SECONDS);
  const length = wanted > 0 ? Math.min(wanted, longest) : longest;
  const clampedStart = Math.min(Math.max(start, 0), Math.max(fileDuration - length, 0));

  return { start: clampedStart, end: clampedStart + length };
}

export function clipSeconds(window: ClipWindow): number {
  return window.end - window.start;
}
