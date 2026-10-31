import { encodeWav } from "@/lib/audio/wav";
import type { Chord, Isolation, Note, TrackMap } from "@/lib/trackmap/trackmap.generated";

export type ResolvedStemUrls = {
  mixUrl: string;
  soundUrl: string;
  restUrl: string;
  isSynthesizedPreview: boolean;
  revoke: () => void;
};

const SYNTH_SAMPLE_RATE = 22_050;
const TWO_PI = Math.PI * 2;
const INV_SAMPLE_RATE = 1 / SYNTH_SAMPLE_RATE;

const ASSET_EXISTS_CACHE = new Map<string, boolean>();
const SYNTH_BLOB_CACHE = new Map<string, { soundUrl: string; restUrl: string; mixUrl: string }>();

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function renderNotesBuffer(notes: Note[], duration: number, isPianoLike: boolean): Float32Array {
  const totalFrames = Math.max(1, Math.round(duration * SYNTH_SAMPLE_RATE));
  const samples = new Float32Array(totalFrames);
  const decayRate = isPianoLike ? 3.0 : 1.2;

  for (const note of notes) {
    const startFrame = Math.max(0, Math.floor(note.start * SYNTH_SAMPLE_RATE));
    const endFrame = Math.min(totalFrames, Math.ceil((note.end + 0.08) * SYNTH_SAMPLE_RATE));
    if (endFrame <= startFrame) continue;

    const freq = midiToHz(note.pitch);
    const gain = (Math.max(30, Math.min(127, note.velocity)) / 127) * (isPianoLike ? 0.15 : 0.2);
    const noteLength = Math.max(0.05, note.end - note.start);
    const phaseInc = TWO_PI * freq * INV_SAMPLE_RATE;

    let phase = 0;
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const localSec = (frame - startFrame) * INV_SAMPLE_RATE;
      const attack = localSec < 0.008 ? localSec / 0.008 : 1;
      const release =
        localSec <= noteLength
          ? Math.exp(-localSec * decayRate)
          : Math.max(0, 1 - (localSec - noteLength) / 0.08) * 0.5;
      const env = attack * release * gain;

      let wave = 0;
      if (isPianoLike) {
        wave = Math.sin(phase) * 0.72 + Math.sin(phase * 2) * 0.2;
      } else {
        wave = 2 * ((phase / TWO_PI) % 1) - 1;
      }
      samples[frame] = (samples[frame] ?? 0) + wave * env;

      phase += phaseInc;
      if (phase >= TWO_PI) phase -= TWO_PI;
    }
  }

  return samples;
}

function getChordIntervals(label: string): number[] {
  const clean = label.trim();
  const isMinor = clean.includes("m") && !clean.includes("maj") && !clean.includes("dim");
  const isDim = clean.includes("dim");
  if (isDim) return [0, 3, 6];
  if (isMinor) return [0, 3, 7];
  return [0, 4, 7];
}

function renderBackingBuffer(chords: Chord[], beats: number[], duration: number): Float32Array {
  const totalFrames = Math.max(1, Math.round(duration * SYNTH_SAMPLE_RATE));
  const samples = new Float32Array(totalFrames);

  for (const chord of chords) {
    const rootMidi = chord.root_midi ?? 57;
    const intervals = getChordIntervals(chord.label);
    const chordFrequencies = intervals.map((semi) => midiToHz(rootMidi + semi));
    const bassHz = midiToHz(rootMidi - 12);
    const startFrame = Math.max(0, Math.floor(chord.start * SYNTH_SAMPLE_RATE));
    const endFrame = Math.min(totalFrames, Math.floor(chord.end * SYNTH_SAMPLE_RATE));
    const chordLen = chord.end - chord.start;

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const localSec = (frame - startFrame) * INV_SAMPLE_RATE;
      const attack = localSec < 0.04 ? localSec / 0.04 : 1;
      const release = chordLen - localSec < 0.05 ? Math.max(0, (chordLen - localSec) / 0.05) : 1;
      const padEnv = attack * release;

      let chordWave = 0;
      for (let i = 0; i < chordFrequencies.length; i++) {
        const hz = chordFrequencies[i] ?? 440;
        chordWave += Math.sin(TWO_PI * hz * localSec);
      }
      chordWave = (chordWave / chordFrequencies.length) * 0.16;

      const bass = Math.sin(TWO_PI * bassHz * localSec) * 0.18;
      samples[frame] = (samples[frame] ?? 0) + (chordWave + bass) * padEnv;
    }
  }

  for (let beatIdx = 0; beatIdx < beats.length; beatIdx += 1) {
    const beatStart = beats[beatIdx];
    if (beatStart === undefined) continue;
    const startFrame = Math.max(0, Math.floor(beatStart * SYNTH_SAMPLE_RATE));
    const hitFrames = Math.min(totalFrames - startFrame, Math.floor(0.09 * SYNTH_SAMPLE_RATE));
    const isDownbeat = beatIdx % 4 === 0;

    for (let offset = 0; offset < hitFrames; offset += 1) {
      const sec = offset * INV_SAMPLE_RATE;
      const pitchSweep = isDownbeat ? 115 * Math.exp(-sec * 28) + 46 : 90 * Math.exp(-sec * 34) + 44;
      const kick = Math.sin(TWO_PI * pitchSweep * sec) * Math.exp(-sec * 24) * (isDownbeat ? 0.22 : 0.15);
      const frame = startFrame + offset;
      samples[frame] = (samples[frame] ?? 0) + kick;
    }
  }

  return samples;
}

function toBlobUrl(mono: Float32Array): string {
  const wav = encodeWav({ channels: [mono], sampleRate: SYNTH_SAMPLE_RATE });
  return URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
}

async function assetExists(url: string): Promise<boolean> {
  if (!url || !url.startsWith("/demos/")) return true;
  const cached = ASSET_EXISTS_CACHE.get(url);
  if (cached !== undefined) return cached;
  const response = await fetch(url, { method: "HEAD" }).catch(() => null);
  const exists = response !== null && response.ok;
  ASSET_EXISTS_CACHE.set(url, exists);
  return exists;
}

/** Resolves playable URLs for `StemPlayer`; synthesizes in-memory WAVs if demo assets are not yet generated. */
export async function resolvePlayableStems(
  trackMap: TrackMap,
  isolation: Isolation,
  soundUrlOverride?: string,
): Promise<ResolvedStemUrls> {
  const targetSoundUrl = soundUrlOverride ?? isolation.sound_url;
  const targetRestUrl = isolation.rest_url;
  const targetMixUrl = trackMap.source.mix_url ?? targetSoundUrl;

  const [hasSound, hasRest, hasMix] = await Promise.all([
    assetExists(targetSoundUrl),
    assetExists(targetRestUrl),
    assetExists(targetMixUrl),
  ]);

  if (hasSound && hasRest && hasMix) {
    return {
      mixUrl: targetMixUrl,
      soundUrl: targetSoundUrl,
      restUrl: targetRestUrl,
      isSynthesizedPreview: false,
      revoke: () => {},
    };
  }

  // Persistent in-memory session cache for synthesized stems
  const cacheKey = `${trackMap.source.title}:${isolation.id}:${trackMap.duration}`;
  const cached = SYNTH_BLOB_CACHE.get(cacheKey);
  if (cached !== undefined) {
    return {
      mixUrl: hasMix ? targetMixUrl : cached.mixUrl,
      soundUrl: hasSound ? targetSoundUrl : cached.soundUrl,
      restUrl: hasRest ? targetRestUrl : cached.restUrl,
      isSynthesizedPreview: true,
      revoke: () => {},
    };
  }

  const isPiano = isolation.label.toLowerCase().includes("piano");
  const soundSamples = renderNotesBuffer(isolation.notes, trackMap.duration, isPiano);
  const restSamples = renderBackingBuffer(trackMap.chords, trackMap.beats, trackMap.duration);
  const mixSamples = new Float32Array(soundSamples.length);
  for (let index = 0; index < mixSamples.length; index += 1) {
    mixSamples[index] = Math.max(-0.98, Math.min(0.98, (soundSamples[index] ?? 0) + (restSamples[index] ?? 0)));
  }

  const soundUrl = hasSound ? targetSoundUrl : toBlobUrl(soundSamples);
  const restUrl = hasRest ? targetRestUrl : toBlobUrl(restSamples);
  const mixUrl = hasMix ? targetMixUrl : toBlobUrl(mixSamples);

  SYNTH_BLOB_CACHE.set(cacheKey, { soundUrl, restUrl, mixUrl });

  return {
    mixUrl,
    soundUrl,
    restUrl,
    isSynthesizedPreview: true,
    revoke: () => {},
  };
}

