import type { LoopRange } from "@/lib/audio/player";
import type { Note } from "@/lib/trackmap/trackmap.generated";

export type StudioPalette = {
  bg: string;
  surface: string;
  line: string;
  line2: string;
  inactive: string;
  mutedWave: string;
  text: string;
  text2: string;
  muted: string;
  accent: string;
  you: string;
  rest: string;
  leftHand: string;
};

export type PlayedNoteDot = {
  time: number;
  pitch: number;
  offsetMs: number;
};

export type WaveformDrawArgs = {
  canvas: HTMLCanvasElement;
  peaks: number[];
  currentTime: number;
  duration: number;
  downbeats: number[];
  audible: boolean;
  tone: "accent" | "rest";
  loop: LoopRange | null;
};

export type MiniRollDrawArgs = {
  canvas: HTMLCanvasElement;
  notes: Note[];
  currentTime: number;
  duration: number;
  downbeats: number[];
};

export type EnergyDrawArgs = {
  canvas: HTMLCanvasElement;
  values: number[];
  currentTime: number;
  duration: number;
  downbeats: number[];
};

export type LearnRollDrawArgs = {
  canvas: HTMLCanvasElement;
  notes: Note[];
  played: PlayedNoteDot[];
  currentTime: number;
  duration: number;
  downbeats: number[];
  loop: LoopRange | null;
  problemBarZeroBased: number | null;
};

function token(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const val = styles.getPropertyValue(name).trim();
  return val.length > 0 ? val : fallback;
}

export function readStudioPalette(): StudioPalette {
  const styles = window.getComputedStyle(document.documentElement);
  return {
    bg: token(styles, "--bg", "black"),
    surface: token(styles, "--surface", "black"),
    line: token(styles, "--line", "gray"),
    line2: token(styles, "--line-2", "gray"),
    inactive: token(styles, "--inactive", "gray"),
    mutedWave: token(styles, "--muted-wave", "gray"),
    text: token(styles, "--text", "white"),
    text2: token(styles, "--text-2", "silver"),
    muted: token(styles, "--text-muted", "gray"),
    accent: token(styles, "--accent", "orange"),
    you: token(styles, "--you", "gold"),
    rest: token(styles, "--rest", "silver"),
    leftHand: token(styles, "--left-hand", "slategray"),
  };
}

function drawBarGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  downbeats: number[],
  duration: number,
  strokeStyle: string,
): void {
  if (duration <= 0) return;
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 1;
  for (let index = 1; index < downbeats.length; index += 1) {
    const beat = downbeats[index];
    if (beat === undefined) continue;
    const x = Math.round((beat / duration) * width) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
}

function drawLoopShade(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  loop: LoopRange | null,
  duration: number,
  fillStyle: string,
): void {
  if (loop === null || duration <= 0) return;
  const x = (loop.startSeconds / duration) * width;
  const w = Math.max(2, ((loop.endSeconds - loop.startSeconds) / duration) * width);
  ctx.save();
  ctx.globalAlpha = 0.06;
  ctx.fillStyle = fillStyle;
  ctx.fillRect(x, 0, w, height);
  ctx.restore();
}

function drawPlayhead(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  currentTime: number,
  duration: number,
  fillStyle: string,
): void {
  if (duration <= 0) return;
  const x = Math.max(0, Math.min(width - 1.5, (currentTime / duration) * width));
  ctx.fillStyle = fillStyle;
  ctx.fillRect(x, 0, 1.5, height);
}

export function drawWaveformLane({
  canvas,
  peaks,
  currentTime,
  duration,
  downbeats,
  audible,
  tone,
  loop,
}: WaveformDrawArgs): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const width = canvas.width;
  const height = canvas.height;
  const palette = readStudioPalette();

  ctx.clearRect(0, 0, width, height);
  drawLoopShade(ctx, width, height, loop, duration, palette.text);
  drawBarGrid(ctx, width, height, downbeats, duration, palette.line);

  const count = Math.max(1, peaks.length);
  const step = width / count;
  const playX = duration > 0 ? (currentTime / duration) * width : 0;
  const activeColor = tone === "accent" ? palette.accent : palette.rest;

  for (let index = 0; index < count; index += 1) {
    const mag = Math.max(0.05, Math.min(1, peaks[index] ?? 0.15));
    const barHeight = Math.max(3, mag * (height - 14));
    const x = index * step;
    const y = (height - barHeight) / 2;

    if (!audible) {
      ctx.fillStyle = palette.mutedWave;
    } else if (x <= playX) {
      ctx.fillStyle = activeColor;
    } else {
      ctx.fillStyle = palette.inactive;
    }
    ctx.fillRect(x + 1, y, Math.max(1.5, step - 2), barHeight);
  }

  drawPlayhead(ctx, width, height, currentTime, duration, palette.text);
}

export function drawMiniRoll({
  canvas,
  notes,
  currentTime,
  duration,
  downbeats,
}: MiniRollDrawArgs): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const width = canvas.width;
  const height = canvas.height;
  const palette = readStudioPalette();

  ctx.clearRect(0, 0, width, height);
  drawBarGrid(ctx, width, height, downbeats, duration, palette.line);

  if (duration > 0 && notes.length > 0) {
    let minPitch = 127;
    let maxPitch = 0;
    for (const note of notes) {
      if (note.pitch < minPitch) minPitch = note.pitch;
      if (note.pitch > maxPitch) maxPitch = note.pitch;
    }
    const low = Math.max(36, minPitch - 3);
    const span = Math.max(12, maxPitch - low + 3);

    for (const note of notes) {
      const x = (note.start / duration) * width;
      const w = Math.max(4, ((note.end - note.start) / duration) * width - 1);
      const norm = Math.max(0, Math.min(1, (note.pitch - low) / span));
      const y = height - 12 - norm * (height - 24);
      const active = currentTime >= note.start && currentTime <= note.end;
      ctx.fillStyle = active ? palette.accent : palette.text;
      ctx.fillRect(x, y, w, 6);
    }
  }

  drawPlayhead(ctx, width, height, currentTime, duration, palette.accent);
}

export function drawEnergyCurve({
  canvas,
  values,
  currentTime,
  duration,
  downbeats,
}: EnergyDrawArgs): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const width = canvas.width;
  const height = canvas.height;
  const palette = readStudioPalette();

  ctx.clearRect(0, 0, width, height);
  drawBarGrid(ctx, width, height, downbeats, duration, palette.line);

  if (values.length > 1) {
    ctx.strokeStyle = palette.text2;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let index = 0; index < values.length; index += 1) {
      const x = (index / (values.length - 1)) * width;
      const val = Math.max(0, Math.min(1, values[index] ?? 0));
      const y = height - 6 - val * (height - 14);
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  drawPlayhead(ctx, width, height, currentTime, duration, palette.text);
}

export function drawLearnPianoRoll({
  canvas,
  notes,
  played,
  currentTime,
  duration,
  downbeats,
  loop,
  problemBarZeroBased,
}: LearnRollDrawArgs): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const width = canvas.width;
  const height = canvas.height;
  const palette = readStudioPalette();

  ctx.clearRect(0, 0, width, height);
  drawLoopShade(ctx, width, height, loop, duration, palette.text);

  if (problemBarZeroBased !== null && duration > 0 && downbeats.length > 0) {
    const barStart = downbeats[problemBarZeroBased] ?? 0;
    const barEnd = downbeats[problemBarZeroBased + 1] ?? duration;
    const px = (barStart / duration) * width;
    const pw = Math.max(6, ((barEnd - barStart) / duration) * width);

    ctx.save();
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = palette.you;
    ctx.fillRect(px, 0, pw, height);
    ctx.restore();

    ctx.save();
    ctx.strokeStyle = palette.you;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(px + 0.5, 0.5, pw - 1, height - 1);
    ctx.restore();
  }

  drawBarGrid(ctx, width, height, downbeats, duration, palette.line);

  // Bar numbers along top edge
  if (duration > 0) {
    ctx.font = "600 10px monospace";
    for (let index = 0; index < downbeats.length; index += 1) {
      const beat = downbeats[index];
      if (beat === undefined) continue;
      const x = (beat / duration) * width + 4;
      ctx.fillStyle = problemBarZeroBased === index ? palette.you : palette.muted;
      ctx.fillText(String(index + 1), x, 12);
    }
  }

  const lowPitch = 45;
  const pitchSpan = 40;

  if (duration > 0) {
    for (const note of notes) {
      const x = (note.start / duration) * width;
      const w = Math.max(5, ((note.end - note.start) / duration) * width - 1.5);
      const norm = Math.max(0, Math.min(1, (note.pitch - lowPitch) / pitchSpan));
      const y = height - 16 - norm * (height - 36);
      const active = currentTime >= note.start && currentTime <= note.end;
      if (note.hand === "left") {
        ctx.fillStyle = palette.leftHand;
        ctx.fillRect(x, y, w, 6);
      } else {
        ctx.fillStyle = active ? palette.accent : palette.text;
        ctx.fillRect(x, y, w, 8);
      }
    }

    for (const dot of played) {
      const x = (dot.time / duration) * width;
      const norm = Math.max(0, Math.min(1, (dot.pitch - lowPitch) / pitchSpan));
      const y = height - 16 - norm * (height - 36) - 5;
      ctx.fillStyle = palette.you;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawPlayhead(ctx, width, height, currentTime, duration, palette.text);
}

