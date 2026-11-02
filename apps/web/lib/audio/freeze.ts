export type Partial = {
  hertz: number;
  amplitude: number;
};

const MAX_PARTIALS = 32;
// Peaks further than this under the strongest are separation noise, the source of the hiss.
const PEAK_FLOOR = 0.003;
const MIN_HERTZ = 20;
const ZERO_PADDING = 2;

/** In place, radix 2; the length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const size = re.length;
  for (let index = 1, swapped = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; swapped & bit; bit >>= 1) swapped ^= bit;
    swapped ^= bit;
    if (index < swapped) {
      [re[index], re[swapped]] = [re[swapped] ?? 0, re[index] ?? 0];
      [im[index], im[swapped]] = [im[swapped] ?? 0, im[index] ?? 0];
    }
  }
  for (let span = 2; span <= size; span <<= 1) {
    const angle = (-2 * Math.PI) / span;
    for (let start = 0; start < size; start += span) {
      for (let offset = 0; offset < span / 2; offset += 1) {
        const cos = Math.cos(angle * offset);
        const sin = Math.sin(angle * offset);
        const low = start + offset;
        const high = low + span / 2;
        const highRe = re[high] ?? 0;
        const highIm = im[high] ?? 0;
        const turnedRe = highRe * cos - highIm * sin;
        const turnedIm = highRe * sin + highIm * cos;
        re[high] = (re[low] ?? 0) - turnedRe;
        im[high] = (im[low] ?? 0) - turnedIm;
        re[low] = (re[low] ?? 0) + turnedRe;
        im[low] = (im[low] ?? 0) + turnedIm;
      }
    }
  }
}

/** The frequencies a sound is made of. `segment`'s length must be a power of two. */
export function strongestPartials(segment: Float32Array, sampleRate: number): Partial[] {
  const size = segment.length * ZERO_PADDING;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let windowSum = 0;
  segment.forEach((value, index) => {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (segment.length - 1));
    re[index] = value * hann;
    windowSum += hann;
  });
  fft(re, im);

  const half = size / 2;
  const magnitudes = new Float64Array(half + 1);
  let strongest = 0;
  for (let bin = 0; bin <= half; bin += 1) {
    const magnitude = Math.hypot(re[bin] ?? 0, im[bin] ?? 0);
    magnitudes[bin] = magnitude;
    if (magnitude > strongest) strongest = magnitude;
  }
  if (strongest === 0) return [];

  const partials: Partial[] = [];
  for (let bin = 1; bin < half; bin += 1) {
    const peak = magnitudes[bin] ?? 0;
    const left = magnitudes[bin - 1] ?? 0;
    const right = magnitudes[bin + 1] ?? 0;
    if (peak <= left || peak < right || peak < strongest * PEAK_FLOOR) continue;
    // A peak falls between bins; a parabola through the log magnitudes finds where.
    const a = Math.log(Math.max(left, 1e-12));
    const b = Math.log(peak);
    const c = Math.log(Math.max(right, 1e-12));
    const shift = (0.5 * (a - c)) / (a - 2 * b + c);
    const hertz = ((bin + shift) * sampleRate) / size;
    if (hertz < MIN_HERTZ) continue;
    partials.push({ hertz, amplitude: (2 * Math.exp(b - 0.25 * (a - c) * shift)) / windowSum });
  }
  return partials.sort((x, y) => y.amplitude - x.amplitude).slice(0, MAX_PARTIALS);
}

/**
 * Steady sine waves at those frequencies. Each makes a whole number of cycles in `length` samples, so
 * the result loops with no join, and nothing in it wavers as a repeated slice of a chord does.
 */
export function renderPartials(
  partials: readonly Partial[],
  sampleRate: number,
  length: number,
  targetRms: number,
  random: () => number = Math.random,
): Float32Array {
  const output = new Float32Array(length);
  for (const partial of partials) {
    const cycles = Math.max(1, Math.round((partial.hertz * length) / sampleRate));
    const step = (2 * Math.PI * cycles) / length;
    const stepCos = Math.cos(step);
    const stepSin = Math.sin(step);
    const phase = 2 * Math.PI * random();
    let cos = Math.cos(phase);
    let sin = Math.sin(phase);
    for (let index = 0; index < length; index += 1) {
      output[index] = (output[index] ?? 0) + partial.amplitude * sin;
      const nextCos = cos * stepCos - sin * stepSin;
      sin = sin * stepCos + cos * stepSin;
      cos = nextCos;
    }
  }
  let sum = 0;
  for (const value of output) sum += value * value;
  const rms = Math.sqrt(sum / length);
  if (rms === 0) return output;
  const gain = targetRms / rms;
  for (let index = 0; index < length; index += 1) output[index] = (output[index] ?? 0) * gain;
  return output;
}
