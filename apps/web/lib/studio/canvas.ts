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
  dpr?: number;
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
  for (let index = 1; index < downbeats.length; index += 1) {
    const beat = downbeats[index];
    if (beat === undefined) continue;
    const x = Math.round((beat / duration) * width) + 0.5;
    const isMajor = index % 4 === 0;
    ctx.save();
    ctx.strokeStyle = strokeStyle;
    ctx.globalAlpha = isMajor ? 0.38 : 0.14;
    ctx.lineWidth = isMajor ? 1 : 0.75;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
    ctx.restore();
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
  ctx.globalAlpha = 0.08;
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
  fillStyleOrTone: string | "accent" | "rest",
  palette?: StudioPalette,
): void {
  if (duration <= 0) return;
  const x = Math.max(0, Math.min(width - 1.5, (currentTime / duration) * width));
  const isAccent = fillStyleOrTone === "accent";
  const color =
    isAccent
      ? palette?.accent ?? "#ff6a1a"
      : fillStyleOrTone === "rest"
        ? palette?.text ?? "#ffffff"
        : fillStyleOrTone;
  const glow = isAccent ? "rgba(255, 106, 26, 0.65)" : "rgba(255, 255, 255, 0.45)";

  ctx.save();
  ctx.shadowColor = glow;
  ctx.shadowBlur = 6;
  ctx.fillStyle = color;
  ctx.fillRect(x - 0.75, 0, 1.5, height);

  // Top triangular needle marker
  ctx.beginPath();
  ctx.moveTo(x - 3.5, 0);
  ctx.lineTo(x + 3.5, 0);
  ctx.lineTo(x, 5);
  ctx.closePath();
  ctx.fill();

  // Bottom triangular needle marker
  ctx.beginPath();
  ctx.moveTo(x - 3.5, height);
  ctx.lineTo(x + 3.5, height);
  ctx.lineTo(x, height - 5);
  ctx.closePath();
  ctx.fill();

  ctx.restore();
}

/** Resamples a peak array of arbitrary length to a target number of bars using linear interpolation. */
export function resamplePeaks(peaks: number[], targetCount: number): number[] {
  if (peaks.length === 0) return new Array(targetCount).fill(0.08);
  if (peaks.length === targetCount) return peaks;
  const result: number[] = new Array(targetCount);
  const scale = (peaks.length - 1) / Math.max(1, targetCount - 1);
  for (let i = 0; i < targetCount; i++) {
    const srcIndex = i * scale;
    const low = Math.floor(srcIndex);
    const high = Math.min(peaks.length - 1, Math.ceil(srcIndex));
    const weight = srcIndex - low;
    const pLow = peaks[low] ?? 0.08;
    const pHigh = peaks[high] ?? 0.08;
    const val = pLow * (1 - weight) + pHigh * weight;
    result[i] = Math.max(0.02, Math.min(1.0, val));
  }
  return result;
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
  dpr: explicitDpr,
}: WaveformDrawArgs): void {
  const ctx = canvas.getContext("2d");
  if (ctx === null) return;
  const dpr =
    explicitDpr ??
    (typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 3) : 1);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  const palette = readStudioPalette();

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);

  // 1. Loop region shading
  drawLoopShade(ctx, width, height, loop, duration, palette.text);

  // 2. Measure / Bar grid lines
  drawBarGrid(ctx, width, height, downbeats, duration, palette.line);

  // 3. Faint Centerline for authentic oscilloscope/DAW baseline feel
  const centerY = height / 2;
  ctx.save();
  ctx.strokeStyle = palette.line2;
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, centerY + 0.5);
  ctx.lineTo(width, centerY + 0.5);
  ctx.stroke();
  ctx.restore();

  // 4. Adaptive dynamic needle density: dense, razor-sharp on 4K/Retina displays
  const slotWidth = width > 1400 ? 3.5 : width > 800 ? 3.0 : 2.5;
  const barWidth = width > 1400 ? 2.2 : width > 800 ? 1.8 : 1.5;
  const count = Math.max(24, Math.floor(width / slotWidth));
  const resampled = resamplePeaks(peaks, count);
  const playX = duration > 0 ? (currentTime / duration) * width : 0;
  const maxAmplitudeHalf = (height - 18) / 2;

  // 5. Pre-create vertical gradients
  let activeGradient: CanvasGradient | string;
  let inactiveGradient: CanvasGradient | string;

  const isLight =
    palette.bg === "#ffffff" ||
    palette.bg.startsWith("#f7") ||
    palette.bg.startsWith("#eff") ||
    palette.bg === "rgb(247, 248, 250)";

  if (tone === "accent") {
    const grad = ctx.createLinearGradient(0, centerY - maxAmplitudeHalf, 0, centerY + maxAmplitudeHalf);
    grad.addColorStop(0.0, "#ffb370"); // illuminated crest
    grad.addColorStop(0.25, "#ff721a"); // vivid accent orange
    grad.addColorStop(0.5, "#ff5000"); // deep core
    grad.addColorStop(0.75, "#ff721a");
    grad.addColorStop(1.0, "#cc3a00"); // bottom edge
    activeGradient = grad;

    const inGrad = ctx.createLinearGradient(0, centerY - maxAmplitudeHalf, 0, centerY + maxAmplitudeHalf);
    if (isLight) {
      inGrad.addColorStop(0.0, "rgba(255, 106, 26, 0.45)");
      inGrad.addColorStop(0.5, "rgba(255, 106, 26, 0.22)");
      inGrad.addColorStop(1.0, "rgba(255, 106, 26, 0.40)");
    } else {
      inGrad.addColorStop(0.0, "rgba(255, 106, 26, 0.40)");
      inGrad.addColorStop(0.5, "rgba(255, 106, 26, 0.18)");
      inGrad.addColorStop(1.0, "rgba(255, 106, 26, 0.35)");
    }
    inactiveGradient = inGrad;
  } else {
    // Rest or master stem
    const grad = ctx.createLinearGradient(0, centerY - maxAmplitudeHalf, 0, centerY + maxAmplitudeHalf);
    if (isLight) {
      grad.addColorStop(0.0, "#0f172a");
      grad.addColorStop(0.5, "#334155");
      grad.addColorStop(1.0, "#1e293b");
    } else {
      grad.addColorStop(0.0, "#ffffff");
      grad.addColorStop(0.5, "#cbd5e1");
      grad.addColorStop(1.0, "#94a3b8");
    }
    activeGradient = grad;

    const inGrad = ctx.createLinearGradient(0, centerY - maxAmplitudeHalf, 0, centerY + maxAmplitudeHalf);
    if (isLight) {
      inGrad.addColorStop(0.0, "rgba(100, 116, 139, 0.35)");
      inGrad.addColorStop(0.5, "rgba(100, 116, 139, 0.18)");
      inGrad.addColorStop(1.0, "rgba(100, 116, 139, 0.28)");
    } else {
      inGrad.addColorStop(0.0, "rgba(148, 163, 184, 0.32)");
      inGrad.addColorStop(0.5, "rgba(148, 163, 184, 0.14)");
      inGrad.addColorStop(1.0, "rgba(148, 163, 184, 0.26)");
    }
    inactiveGradient = inGrad;
  }

  const radius = Math.min(1.5, barWidth / 2);
  const actualSlot = width / count;

  for (let index = 0; index < count; index += 1) {
    const mag = Math.max(0.04, Math.min(1.0, resampled[index] ?? 0.1));
    const barHeight = Math.max(4, mag * (height - 18));
    const x = index * actualSlot + (actualSlot - barWidth) / 2;
    const y = centerY - barHeight / 2;

    if (!audible) {
      ctx.fillStyle = palette.mutedWave;
    } else if (x <= playX) {
      ctx.fillStyle = activeGradient;
    } else {
      ctx.fillStyle = inactiveGradient;
    }

    if (ctx.roundRect) {
      ctx.beginPath();
      ctx.roundRect(x, y, barWidth, barHeight, radius);
      ctx.fill();
    } else {
      ctx.fillRect(x, y, barWidth, barHeight);
    }
  }

  // 6. Draw illuminated playhead with top/bottom marker pips
  drawPlayhead(ctx, width, height, currentTime, duration, tone, palette);

  ctx.restore();
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

