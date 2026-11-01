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
  source: AudioBufferSourceNode;
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

/** Plays keys from the selected sound itself, so what you press sounds like what you hear. */
export class KeySampler {
  private readonly context = new AudioContext({ latencyHint: "interactive" });
  private readonly active = new Map<number, ActiveKey>();
  private buffer: AudioBuffer | null = null;
  private samples: KeySample[] = [];
  private offset = 0;

  async load(url: string, notes: readonly SamplerNote[], octaveOffset: number): Promise<boolean> {
    const samples = pickKeySamples(notes);
    if (samples.length === 0) return false;
    const response = await fetch(url);
    if (!response.ok) return false;
    this.buffer = await this.context.decodeAudioData(await response.arrayBuffer());
    this.samples = samples;
    this.offset = octaveOffset;
    return true;
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
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + ATTACK_SECONDS);
    source.connect(gain).connect(this.context.destination);
    source.start(now, start, sample.end - start);
    source.onended = () => {
      if (this.active.get(key)?.source === source) this.active.delete(key);
    };
    this.active.set(key, { source, gain });
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
    voice.source.stop(now + RELEASE_SECONDS);
    return true;
  }

  async dispose(): Promise<void> {
    this.active.clear();
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
