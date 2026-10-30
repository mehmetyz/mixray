import { encodeWav } from "./wav";

const TARGET_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER_SIZE = 4_096;

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

/** Captures microphone audio as the mono 16-bit PCM WAV accepted by Muse Voice Transcribe. */
export async function startVoiceRecording(): Promise<VoiceRecording> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new VoiceRecordingError("Microphone recording is unavailable. Use a text command instead.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    throw new VoiceRecordingError("Microphone access was not granted. Use a text command instead.");
  }

  let context: AudioContext;
  try {
    context = new AudioContext();
  } catch {
    stopTracks(stream);
    throw new VoiceRecordingError("Microphone recording is unavailable. Use a text command instead.");
  }
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  const silentGain = context.createGain();
  const chunks: Float32Array[] = [];
  let isFinished = false;

  silentGain.gain.value = 0;
  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (!isFinished) chunks.push(mixToMono(event.inputBuffer));
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(context.destination);

  async function finish(): Promise<void> {
    if (isFinished) return;
    isFinished = true;
    processor.disconnect();
    source.disconnect();
    silentGain.disconnect();
    stopTracks(stream);
    await context.close();
  }

  return {
    async stop(): Promise<Blob> {
      await finish();
      const samples = resampleToTarget(combineSamples(chunks), context.sampleRate);
      if (samples.length === 0) {
        throw new VoiceRecordingError("No microphone audio was recorded. Use a text command instead.");
      }
      const wav = encodeWav({ channels: [samples], sampleRate: TARGET_SAMPLE_RATE });
      return new Blob([wav], { type: "audio/wav" });
    },
    async cancel(): Promise<void> {
      await finish();
    },
  };
}
