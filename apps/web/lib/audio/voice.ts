import { SpeechGate } from "./vad";
import { encodeWav } from "./wav";

const TARGET_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER_SIZE = 4_096;
const PRE_ROLL_CHUNKS = 4;

export class VoiceRecordingError extends Error {
  override name = "VoiceRecordingError";
}

export type VoiceRecording = {
  stop: () => Promise<Blob>;
  cancel: () => Promise<void>;
};

function mixToMono(input: AudioBuffer): Float32Array {
  const frameCount = input.length;
  const output = new Float32Array(frameCount);

  for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
    const samples = input.getChannelData(channel);
    for (let frame = 0; frame < frameCount; frame += 1) {
      output[frame] = (output[frame] ?? 0) + (samples[frame] ?? 0);
    }
  }

  for (let frame = 0; frame < frameCount; frame += 1) {
    output[frame] = (output[frame] ?? 0) / input.numberOfChannels;
  }

  return output;
}

function combineSamples(chunks: Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }

  return samples;
}

function resampleToTarget(samples: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === TARGET_SAMPLE_RATE) return samples;

  const outputLength = Math.round((samples.length * TARGET_SAMPLE_RATE) / sourceRate);
  const output = new Float32Array(outputLength);
  const sourcePerOutput = sourceRate / TARGET_SAMPLE_RATE;

  for (let index = 0; index < outputLength; index += 1) {
    const sourcePosition = index * sourcePerOutput;
    const before = Math.floor(sourcePosition);
    const after = Math.min(before + 1, samples.length - 1);
    const amount = sourcePosition - before;
    const start = samples[before] ?? 0;
    const end = samples[after] ?? start;
    output[index] = start + (end - start) * amount;
  }

  return output;
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function toWavBlob(chunks: Float32Array[], sampleRate: number): Blob {
  const samples = resampleToTarget(combineSamples(chunks), sampleRate);
  return new Blob([encodeWav({ channels: [samples], sampleRate: TARGET_SAMPLE_RATE })], { type: "audio/wav" });
}

function levelOf(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export type HandsFreeOptions = {
  /** Receives each spoken phrase as the mono 16-bit PCM WAV accepted by Muse Voice Transcribe. */
  onPhrase: (wav: Blob) => void;
  onSpeaking: (speaking: boolean) => void;
  /** True while the phrase would be our own voice feedback, or one is still being transcribed. */
  shouldIgnore: () => boolean;
};

/** Listens continuously, so commands need no free hand. Echo cancellation keeps the track out. */
export async function startHandsFreeListening(options: HandsFreeOptions): Promise<() => Promise<void>> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new VoiceRecordingError("Microphone is unavailable. Use a text command instead.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    throw new VoiceRecordingError("Microphone access was not granted. Use a text command instead.");
  }

  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    stopTracks(stream);
    throw new VoiceRecordingError("Microphone is unavailable. Use a text command instead.");
  }

  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  const silentGain = context.createGain();
  const gate = new SpeechGate();
  const seconds = PROCESSOR_BUFFER_SIZE / context.sampleRate;
  let preRoll: Float32Array[] = [];
  let phrase: Float32Array[] | null = null;

  silentGain.gain.value = 0;
  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const chunk = mixToMono(event.inputBuffer);
    if (options.shouldIgnore()) {
      gate.reset();
      preRoll = [];
      if (phrase !== null) options.onSpeaking(false);
      phrase = null;
      return;
    }
    const gateEvent = gate.push(levelOf(chunk), seconds);
    if (gateEvent === "started") {
      phrase = [...preRoll];
      options.onSpeaking(true);
    }
    if (phrase !== null) {
      phrase.push(chunk);
    } else {
      preRoll = [...preRoll, chunk].slice(-PRE_ROLL_CHUNKS);
    }
    if (gateEvent === "ended" || gateEvent === "discarded") {
      const finished = phrase;
      phrase = null;
      preRoll = [];
      options.onSpeaking(false);
      if (gateEvent === "ended" && finished !== null) {
        options.onPhrase(toWavBlob(finished, context.sampleRate));
      }
    }
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);
  // Not awaited: a context waiting for a click must not hold up turning voice on.
  void context.resume();

  return async () => {
    processor.onaudioprocess = null;
    processor.disconnect();
    source.disconnect();
    silentGain.disconnect();
    stopTracks(stream);
    await context.close();
  };
}
