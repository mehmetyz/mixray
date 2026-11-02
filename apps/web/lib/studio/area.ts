// Anything shorter than this is a click on the video, which plays or pauses it.
export const MIN_DRAG_PIXELS = 12;
// The engine answers 5 frames a second and treats a longer gap as the object leaving the picture.
const MAX_TRACK_GAP_SECONDS = 0.5;
const BOX_EASE_MS = 140;
const BOX_JUMP_PERCENT = 12;

export type VideoArea = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export type TimedArea = {
  time: number;
  area: VideoArea;
};

export type StageBox = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type StagePoint = {
  x: number;
  y: number;
};

export type PixelSize = {
  width: number;
  height: number;
};

export function clampToStage(point: StagePoint, stage: PixelSize): StagePoint {
  return {
    x: Math.min(stage.width, Math.max(0, point.x)),
    y: Math.min(stage.height, Math.max(0, point.y)),
  };
}

/** The stage letterboxes the video, so a pointer position maps through the fitted picture. */
export function videoAreaFromDrag(
  start: StagePoint,
  end: StagePoint,
  stage: PixelSize,
  video: PixelSize,
): VideoArea {
  const scale = Math.min(stage.width / video.width, stage.height / video.height);
  const offsetX = (stage.width - video.width * scale) / 2;
  const offsetY = (stage.height - video.height * scale) / 2;
  const toVideoX = (x: number) =>
    Math.min(video.width, Math.max(0, Math.round((x - offsetX) / scale)));
  const toVideoY = (y: number) =>
    Math.min(video.height, Math.max(0, Math.round((y - offsetY) / scale)));

  return {
    left: Math.min(toVideoX(start.x), toVideoX(end.x)),
    top: Math.min(toVideoY(start.y), toVideoY(end.y)),
    right: Math.max(toVideoX(start.x), toVideoX(end.x)),
    bottom: Math.max(toVideoY(start.y), toVideoY(end.y)),
  };
}

/** The smallest box around a tracked object's outlines, SVG paths made of absolute x y pairs. */
export function areaAroundPaths(paths: readonly string[]): VideoArea | null {
  const numbers = paths.flatMap((path) => (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number));
  const xs = numbers.filter((_, index) => index % 2 === 0);
  const ys = numbers.filter((_, index) => index % 2 === 1);
  if (ys.length === 0) return null;
  return {
    left: Math.min(...xs),
    top: Math.min(...ys),
    right: Math.max(...xs),
    bottom: Math.max(...ys),
  };
}

/**
 * Where a tracked object is at a moment. Its outlines arrive only a few times a second, so the box
 * glides between them; past the ends, or across a gap where it left the picture, there is no box.
 */
export function areaAtTime(frames: readonly TimedArea[], time: number): VideoArea | null {
  const nextIndex = frames.findIndex((frame) => frame.time > time);
  if (nextIndex === 0) return null;
  const before = frames[nextIndex === -1 ? frames.length - 1 : nextIndex - 1];
  if (before === undefined) return null;
  const after = nextIndex === -1 ? undefined : frames[nextIndex];
  if (after === undefined) return time - before.time <= MAX_TRACK_GAP_SECONDS ? before.area : null;
  const gap = after.time - before.time;
  if (gap > MAX_TRACK_GAP_SECONDS) return null;
  const amount = (time - before.time) / gap;
  const mix = (from: number, to: number) => from + (to - from) * amount;
  return {
    left: mix(before.area.left, after.area.left),
    top: mix(before.area.top, after.area.top),
    right: mix(before.area.right, after.area.right),
    bottom: mix(before.area.bottom, after.area.bottom),
  };
}

/** Where an area of the video sits on a stage that letterboxes it, in percent of the stage. */
export function areaOnStage(area: VideoArea, video: PixelSize, stage: PixelSize): StageBox {
  const scale = Math.min(stage.width / video.width, stage.height / video.height);
  const offsetX = (stage.width - video.width * scale) / 2;
  const offsetY = (stage.height - video.height * scale) / 2;
  return {
    left: ((offsetX + area.left * scale) / stage.width) * 100,
    top: ((offsetY + area.top * scale) / stage.height) * 100,
    width: (((area.right - area.left) * scale) / stage.width) * 100,
    height: (((area.bottom - area.top) * scale) / stage.height) * 100,
  };
}

/** Follows the object with a short lag, so its box drifts rather than twitches; a seek jumps at once. */
export function easeStageBox(current: StageBox, target: StageBox, elapsedMs: number): StageBox {
  const furthest = Math.max(
    Math.abs(target.left - current.left),
    Math.abs(target.top - current.top),
    Math.abs(target.width - current.width),
    Math.abs(target.height - current.height),
  );
  if (furthest > BOX_JUMP_PERCENT) return target;
  const amount = 1 - Math.exp(-elapsedMs / BOX_EASE_MS);
  const mix = (from: number, to: number) => from + (to - from) * amount;
  return {
    left: mix(current.left, target.left),
    top: mix(current.top, target.top),
    width: mix(current.width, target.width),
    height: mix(current.height, target.height),
  };
}

/** The engine stores its own 720p copy, so an area drawn on the source file is rescaled to it. */
export function scaleVideoArea(area: VideoArea, from: PixelSize, to: PixelSize): VideoArea {
  const scaleX = to.width / from.width;
  const scaleY = to.height / from.height;
  return {
    left: Math.max(0, Math.floor(area.left * scaleX)),
    top: Math.max(0, Math.floor(area.top * scaleY)),
    right: Math.min(to.width, Math.ceil(area.right * scaleX)),
    bottom: Math.min(to.height, Math.ceil(area.bottom * scaleY)),
  };
}
