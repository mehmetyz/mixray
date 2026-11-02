import { renderPartials, strongestPartials } from "./freeze";

export type SamplerNote = {
  start: number;
  end: number;
  pitch: number;
  velocity?: number;
};

export type KeySample = {
  pitch: number;
  start: number;
  end: number;
};

type ActiveKey = {
  sources: AudioBufferSourceNode[];
  gain: GainNode;
};

const SAME_ONSET_SECONDS = 0.03;
const MIN_SAMPLE_SECONDS = 0.12;
const MAX_SAMPLE_SECONDS = 2.5;
const SAMPLE_TAIL_SECONDS = 0.03;
const PRE_ROLL_SECONDS = 0.005;
const ATTACK_SECONDS = 0.004;
const RELEASE_SECONDS = 0.1;
const TARGET_RMS = 0.18;
const MAX_NORMALIZE_GAIN = 4;
const OCTAVE = 12;
const ARRANGEMENT_MATCH_SECONDS = 0.2;
// A held key outlasts the note it was sampled from: the frequencies at the end of that note go on as
// steady tones and fade the way a struck string does. Repeating a slice of the audio instead made
// chords waver and hiss, because their notes do not line up on any short loop.
const TAIL_SKIP_ATTACK_SECONDS = 0.03;
const MIN_TAIL_WINDOW = 2048;
const MAX_TAIL_WINDOW = 16384;
const TAIL_SAMPLES = 2 ** 17;
const TAIL_CROSSFADE_SECONDS = 0.08;
const HOLD_DECAY_SECONDS = 5;
// 60 dB under the note, which is where a decay stops being heard.
const DECAY_FLOOR = 0.001;
const END_FADE_SECONDS = 0.03;

/** Picks, for each pitch, the note heard most on its own. A note inside a chord only counts half. */
export function pickKeySamples(notes: readonly SamplerNote[]): KeySample[] {
  const onsets = notes.map((note) => note.start).sort((a, b) => a - b);
  const best = new Map<number, { sample: KeySample; value: number }>();

  for (const note of notes) {
    const nextOnset = onsets.find((onset) => onset > note.start + SAME_ONSET_SECONDS) ?? Infinity;
    const end = Math.min(note.end, nextOnset + SAMPLE_TAIL_SECONDS, note.start + MAX_SAMPLE_SECONDS);
    const length = end - note.start;
    if (length < MIN_SAMPLE_SECONDS) continue;
    const inChord = onsets.filter((onset) => Math.abs(onset - note.start) <= SAME_ONSET_SECONDS).length > 1;
    const value = (inChord ? length / 2 : length) * (1 + (note.velocity ?? 0) / 1270);
    const current = best.get(note.pitch);
    if (current === undefined || value > current.value) {
      best.set(note.pitch, { sample: { pitch: note.pitch, start: note.start, end }, value });
    }
  }
  return [...best.values()].map((item) => item.sample).sort((a, b) => a.pitch - b.pitch);
}

export function nearestKeySample(samples: readonly KeySample[], pitch: number): KeySample | null {
  let nearest: KeySample | null = null;
  for (const sample of samples) {
    if (nearest === null || Math.abs(sample.pitch - pitch) < Math.abs(nearest.pitch - pitch)) {
      nearest = sample;
    }
  }
  return nearest;
}

/**
 * The Learn part is moved by octaves into an easy register, so a shown key can sit octaves away from
 * what the track plays. This is how far, so the same key can sound at the pitch that is heard.
 */
export function arrangementOctaveOffset(
  arrangement: readonly SamplerNote[],
  raw: readonly SamplerNote[],
): number {
  const votes = new Map<number, number>();
  for (const note of arrangement) {
    let nearest: SamplerNote | null = null;
    for (const candidate of raw) {
      if (nearest === null || Math.abs(candidate.start - note.start) < Math.abs(nearest.start - note.start)) {
        nearest = candidate;
      }
    }
    if (nearest === null || Math.abs(nearest.start - note.start) > ARRANGEMENT_MATCH_SECONDS) continue;
    const octaves = Math.round((note.pitch - nearest.pitch) / OCTAVE);
    votes.set(octaves, (votes.get(octaves) ?? 0) + 1);
  }
  let winner = 0;
  let winnerVotes = 0;
  for (const [octaves, count] of votes) {
    if (count > winnerVotes) {
      winner = octaves;
      winnerVotes = count;
    }
  }
  return winner * OCTAVE;
}

/** The steady tones that carry a sample on while its key is held, or null if the note is too short. */
export function sustainTail(
  data: Float32Array,
  sampleRate: number,
  sample: KeySample,
  random?: () => number,
): Float32Array | null {
  const to = Math.min(data.length, Math.floor((sample.end - SAMPLE_TAIL_SECONDS) * sampleRate));
  const from = Math.ceil((sample.start + TAIL_SKIP_ATTACK_SECONDS) * sampleRate);
  if (to - from < MIN_TAIL_WINDOW) return null;
  let window = MAX_TAIL_WINDOW;
  while (window > to - from) window /= 2;
  const segment = data.slice(to - window, to);
  const partials = strongestPartials(segment, sampleRate);
  if (partials.length === 0) return null;
  const rms = Math.sqrt(segment.reduce((sum, value) => sum + value * value, 0) / window);
  return renderPartials(partials, sampleRate, TAIL_SAMPLES, rms, random);
}

/** Plays keys from the selected sound itself, so what you press sounds like what you hear. */
export class KeySampler {
  private readonly context = new AudioContext({ latencyHint: "interactive" });
  private readonly active = new Map<number, ActiveKey>();
  private buffer: AudioBuffer | null = null;
  private samples: KeySample[] = [];
  private readonly tails = new Map<number, AudioBuffer>();
  private offset = 0;

  async load(url: string, notes: readonly SamplerNote[], octaveOffset: number): Promise<boolean> {
    const samples = pickKeySamples(notes);
    if (samples.length === 0) return false;
    const response = await fetch(url);
    if (!response.ok) return false;
    this.buffer = await this.context.decodeAudioData(await response.arrayBuffer());
    this.samples = samples;
    this.offset = octaveOffset;
    void this.prepareTails(this.buffer, samples);
    return true;
  }

  /** A little at a time, so working these out never holds up a key being played. */
  private async prepareTails(buffer: AudioBuffer, samples: readonly KeySample[]): Promise<void> {
    const data = buffer.getChannelData(0);
    for (const sample of samples) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (this.buffer !== buffer) return;
      const tail = sustainTail(data, buffer.sampleRate, sample);
      if (tail === null) continue;
      const rendered = this.context.createBuffer(1, tail.length, buffer.sampleRate);
      rendered.copyToChannel(new Float32Array(tail), 0);
      this.tails.set(sample.pitch, rendered);
    }
  }

  noteOn(key: number, velocity: number): boolean {
    const buffer = this.buffer;
    const pitch = key - this.offset;
    const sample = nearestKeySample(this.samples, pitch);
    if (buffer === null || sample === null) return false;
    this.noteOff(key);
    if (this.context.state === "suspended") void this.context.resume();

    const now = this.context.currentTime;
    const rate = 2 ** ((pitch - sample.pitch) / OCTAVE);
    const start = Math.max(0, sample.start - PRE_ROLL_SECONDS);
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const level = this.levelOf(buffer, sample) * (velocity / 127);
    const gain = this.context.createGain();
    gain.connect(this.context.destination);
    const sources = [source];
    const body = this.context.createGain();
    source.connect(body).connect(gain);
    source.start(now, start, sample.end - start);
    const bodyEnd = now + (sample.end - start) / rate;

    body.gain.setValueAtTime(0, now);
    body.gain.linearRampToValueAtTime(level, now + ATTACK_SECONDS);
    const tailBuffer = this.tails.get(sample.pitch);
    const fade = tailBuffer === undefined ? END_FADE_SECONDS : TAIL_CROSSFADE_SECONDS;
    const fadeFrom = Math.max(now + ATTACK_SECONDS, bodyEnd - fade);
    body.gain.setValueAtTime(level, fadeFrom);
    body.gain.linearRampToValueAtTime(0, bodyEnd);
    source.onended = () => {
      if (tailBuffer === undefined && this.active.get(key)?.gain === gain) this.active.delete(key);
    };

    if (tailBuffer !== undefined) {
      const tail = this.context.createBufferSource();
      tail.buffer = tailBuffer;
      tail.loop = true;
      tail.playbackRate.value = rate;
      const tailGain = this.context.createGain();
      tail.connect(tailGain).connect(gain);
      tailGain.gain.setValueAtTime(0, fadeFrom);
      tailGain.gain.linearRampToValueAtTime(level, bodyEnd);
      tailGain.gain.exponentialRampToValueAtTime(level * DECAY_FLOOR, bodyEnd + HOLD_DECAY_SECONDS);
      tail.start(fadeFrom);
      tail.stop(bodyEnd + HOLD_DECAY_SECONDS);
      tail.onended = () => {
        if (this.active.get(key)?.gain === gain) this.active.delete(key);
      };
      sources.push(tail);
    }
    this.active.set(key, { sources, gain });
    return true;
  }

  noteOff(key: number): boolean {
    const voice = this.active.get(key);
    if (voice === undefined) return this.buffer !== null;
    this.active.delete(key);
    const now = this.context.currentTime;
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.linearRampToValueAtTime(0, now + RELEASE_SECONDS);
    for (const source of voice.sources) source.stop(now + RELEASE_SECONDS);
    return true;
  }

  async dispose(): Promise<void> {
    this.active.clear();
    this.tails.clear();
    this.buffer = null;
    await this.context.close();
  }

  private levelOf(buffer: AudioBuffer, sample: KeySample): number {
    const data = buffer.getChannelData(0);
    const from = Math.floor(sample.start * buffer.sampleRate);
    const to = Math.min(data.length, Math.floor(sample.end * buffer.sampleRate));
    let sum = 0;
    for (let index = from; index < to; index += 1) sum += (data[index] ?? 0) ** 2;
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    return rms > 0 ? Math.min(MAX_NORMALIZE_GAIN, TARGET_RMS / rms) : 1;
  }
}
