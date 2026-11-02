// Anything shorter than this is a click on the video, which plays or pauses it.
export const MIN_DRAG_PIXELS = 12;

export type VideoArea = {
  left: number;
  top: number;
  right: number;
  bottom: number;
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
