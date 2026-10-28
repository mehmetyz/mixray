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

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function renderNotesBuffer(notes: Note[], duration: number, isPianoLike: boolean): Float32Array {
  const totalFrames = Math.max(1, Math.round(duration * SYNTH_SAMPLE_RATE));
  const samples = new Float32Array(totalFrames);

  for (const note of notes) {
    const startFrame = Math.max(0, Math.floor(note.start * SYNTH_SAMPLE_RATE));
    const endFrame = Math.min(totalFrames, Math.ceil((note.end + 0.08) * SYNTH_SAMPLE_RATE));
    if (endFrame <= startFrame) continue;

    const freq = midiToHz(note.pitch);
    const detuneUp = freq * 1.005;
    const detuneDown = freq * 0.995;
    const gain = (Math.max(30, Math.min(127, note.velocity)) / 127) * (isPianoLike ? 0.14 : 0.2);
    const noteLength = Math.max(0.05, note.end - note.start);

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const localSec = (frame - startFrame) / SYNTH_SAMPLE_RATE;
      const attack = Math.min(1, localSec / 0.008);
      const release =
        localSec <= noteLength
          ? Math.exp(-localSec * (isPianoLike ? 3.2 : 1.1))
          : Math.max(0, 1 - (localSec - noteLength) / 0.08) * 0.5;
      const env = attack * release * gain;

      const phase = TWO_PI * freq * localSec;
      let wave = 0;
      if (isPianoLike) {
        wave = Math.sin(phase) * 0.7 + Math.sin(phase * 2) * 0.22 + Math.sin(phase * 3) * 0.08;
      } else {
        const s1 = 2 * ((freq * localSec) % 1) - 1;
        const s2 = 2 * ((detuneUp * localSec) % 1) - 1;
        const s3 = 2 * ((detuneDown * localSec) % 1) - 1;
        wave = (s1 + s2 + s3) / 3;
      }
      samples[frame] = (samples[frame] ?? 0) + wave * env;
    }
  }

  return samples;
}

function renderBackingBuffer(chords: Chord[], beats: number[], duration: number): Float32Array {
  const totalFrames = Math.max(1, Math.round(duration * SYNTH_SAMPLE_RATE));
  const samples = new Float32Array(totalFrames);

  for (const chord of chords) {
    const rootMidi = chord.root_midi ?? 57;
    const fifthMidi = rootMidi + 7;
    const rootHz = midiToHz(rootMidi - 12);
    const fifthHz = midiToHz(fifthMidi - 12);
    const startFrame = Math.max(0, Math.floor(chord.start * SYNTH_SAMPLE_RATE));
    const endFrame = Math.min(totalFrames, Math.floor(chord.end * SYNTH_SAMPLE_RATE));

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const localSec = (frame - startFrame) / SYNTH_SAMPLE_RATE;
      const padEnv = Math.min(1, localSec / 0.04) * Math.min(1, (chord.end - chord.start - localSec) / 0.05);
      const bass = Math.sin(TWO_PI * rootHz * localSec) * 0.16 + Math.sin(TWO_PI * fifthHz * localSec) * 0.07;
      samples[frame] = (samples[frame] ?? 0) + bass * Math.max(0, padEnv);
    }
  }

  for (let beatIdx = 0; beatIdx < beats.length; beatIdx += 1) {
    const beatStart = beats[beatIdx];
    if (beatStart === undefined) continue;
    const startFrame = Math.max(0, Math.floor(beatStart * SYNTH_SAMPLE_RATE));
    const hitFrames = Math.min(totalFrames - startFrame, Math.floor(0.11 * SYNTH_SAMPLE_RATE));
    const isDownbeat = beatIdx % 4 === 0;

    for (let offset = 0; offset < hitFrames; offset += 1) {
      const sec = offset / SYNTH_SAMPLE_RATE;
      const pitchSweep = isDownbeat ? 115 * Math.exp(-sec * 28) + 46 : 90 * Math.exp(-sec * 34) + 44;
      const kick = Math.sin(TWO_PI * pitchSweep * sec) * Math.exp(-sec * 22) * (isDownbeat ? 0.24 : 0.17);
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
  if (!url.startsWith("/demos/")) return true;
  const response = await fetch(url, { method: "HEAD" }).catch(() => null);
  return response !== null && response.ok;
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

  const isPiano = isolation.label.toLowerCase().includes("piano");
  const soundSamples = renderNotesBuffer(isolation.notes, trackMap.duration, isPiano);
  const restSamples = renderBackingBuffer(trackMap.chords, trackMap.beats, trackMap.duration);
  const mixSamples = new Float32Array(soundSamples.length);
  for (let index = 0; index < mixSamples.length; index += 1) {
    mixSamples[index] = Math.max(-0.98, Math.min(0.98, (soundSamples[index] ?? 0) + (restSamples[index] ?? 0)));
  }

  const createdUrls: string[] = [];
  const soundUrl = hasSound ? targetSoundUrl : toBlobUrl(soundSamples);
  if (!hasSound) createdUrls.push(soundUrl);
  const restUrl = hasRest ? targetRestUrl : toBlobUrl(restSamples);
  if (!hasRest) createdUrls.push(restUrl);
  const mixUrl = hasMix ? targetMixUrl : toBlobUrl(mixSamples);
  if (!hasMix) createdUrls.push(mixUrl);

  return {
    mixUrl,
    soundUrl,
    restUrl,
    isSynthesizedPreview: true,
    revoke: () => {
      for (const blobUrl of createdUrls) {
        URL.revokeObjectURL(blobUrl);
      }
    },
  };
}

