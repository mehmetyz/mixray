import { SpeechGate } from "./vad";
import { encodeWav } from "./wav";

const TARGET_SAMPLE_RATE = 16_000;
const FILTER_TAPS = 95;
const FILTER_CUTOFF_HERTZ = 7_200;
const PROCESSOR_BUFFER_SIZE = 4_096;
const ROOM_SECONDS = 0.3;
const EARCON_SECONDS = 0.2;
const LISTEN_SECONDS = 5;
const DEAD_MICROPHONE_LEVEL = 0.0005;
const PADDING_SECONDS = 0.4;

export class VoiceRecordingError extends Error {
  override name = "VoiceRecordingError";
}

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

/** A windowed sinc low-pass. Without it, everything above 8 kHz folds down over the speech. */
function lowPass(samples: Float32Array, cutoffRatio: number): Float32Array {
  const middle = (FILTER_TAPS - 1) / 2;
  const taps = Float64Array.from({ length: FILTER_TAPS }, (_, index) => {
    const offset = index - middle;
    const sinc = offset === 0 ? 2 * cutoffRatio : Math.sin(2 * Math.PI * cutoffRatio * offset) / (Math.PI * offset);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * index) / (FILTER_TAPS - 1)));
  });
  const sum = taps.reduce((total, tap) => total + tap, 0);
  const output = new Float32Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    let value = 0;
    for (let tap = 0; tap < FILTER_TAPS; tap += 1) value += (taps[tap] ?? 0) * (samples[index + tap - middle] ?? 0);
    output[index] = value / sum;
  }
  return output;
}

export function resampleToTarget(input: Float32Array, sourceRate: number): Float32Array {
  if (sourceRate === TARGET_SAMPLE_RATE) return input;

  const samples = sourceRate > TARGET_SAMPLE_RATE ? lowPass(input, (FILTER_CUTOFF_HERTZ / sourceRate)) : input;
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

/**
 * Muse Voice Transcribe returned nothing for a one-word command that starts on the first sample
 * ("play", "pause"), and read it once it had silence around it, measured on synthesised speech.
 */
export function padWithSilence(samples: Float32Array, sampleRate: number): Float32Array {
  const padding = Math.round(PADDING_SECONDS * sampleRate);
  const output = new Float32Array(samples.length + 2 * padding);
  output.set(samples, padding);
  return output;
}

function toWavBlob(chunks: Float32Array[], sampleRate: number): Blob {
  const samples = padWithSilence(resampleToTarget(combineSamples(chunks), sampleRate), TARGET_SAMPLE_RATE);
  return new Blob([encodeWav({ channels: [samples], sampleRate: TARGET_SAMPLE_RATE })], { type: "audio/wav" });
}

function levelOf(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, samples.length));
}

export type ListenOptions = {
  onOpen: () => void;
  onReady: () => void;
  onSpeaking: (speaking: boolean) => void;
  signal: AbortSignal;
};

/**
 * Opens the microphone for one spoken phrase and closes it again. Resolves with what was heard as the
 * mono 16-bit PCM WAV Muse Voice Transcribe accepts, or null if it was cancelled.
 *
 * The gate only ends the wait early. If it never finds the phrase, because the voice is quiet or the
 * room is loud, the recording still goes to the model: a slow answer beats losing a command.
 */
export async function listenForPhrase({
  onOpen,
  onReady,
  onSpeaking,
  signal,
}: ListenOptions): Promise<Blob | null> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new VoiceRecordingError("Microphone is unavailable. Type the command instead.");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch {
    throw new VoiceRecordingError("Microphone access was not granted. Type the command instead.");
  }
  if (signal.aborted) {
    stopTracks(stream);
    return null;
  }

  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
  const silentGain = context.createGain();
  const gate = new SpeechGate();
  const seconds = PROCESSOR_BUFFER_SIZE / context.sampleRate;
  silentGain.gain.value = 0;

  return new Promise<Blob | null>((resolve, reject) => {
    const recording: Float32Array[] = [];
    let openFor = 0;
    let loudest = 0;
    let isReady = false;
    let isSpeaking = false;
    let timedOut = false;
    let closed = false;

    const close = (): boolean => {
      if (closed) return false;
      closed = true;
      window.clearTimeout(giveUp);
      processor.onaudioprocess = null;
      processor.disconnect();
      source.disconnect();
      silentGain.disconnect();
      stopTracks(stream);
      void context.close();
      return true;
    };

    const sendRecording = () => {
      if (!close()) return;
      if (loudest < DEAD_MICROPHONE_LEVEL) {
        reject(new VoiceRecordingError("The microphone is silent. Check the input device."));
        return;
      }
      resolve(toWavBlob(recording, context.sampleRate));
    };

    const giveUp = window.setTimeout(() => {
      timedOut = true;
      if (!isSpeaking) sendRecording();
    }, LISTEN_SECONDS * 1000);

    signal.addEventListener(
      "abort",
      () => {
        if (close()) resolve(null);
      },
      { once: true },
    );

    processor.onaudioprocess = (event: AudioProcessingEvent) => {
      const chunk = mixToMono(event.inputBuffer);
      const level = levelOf(chunk);
      openFor += seconds;
      loudest = Math.max(loudest, level);

      if (openFor < ROOM_SECONDS) {
        gate.learnRoom(level);
        return;
      }
      if (!isReady) {
        isReady = true;
        onReady();
      }
      // The "listening" sound has to fade before anything counts as speech.
      if (openFor < ROOM_SECONDS + EARCON_SECONDS) return;

      // Only now: the model would otherwise read the room and our own sound as words.
      recording.push(chunk);
      const gateEvent = gate.push(level, seconds);
      if (gateEvent === "started") {
        isSpeaking = true;
        onSpeaking(true);
      } else if (gateEvent === "ended") {
        sendRecording();
      } else if (gateEvent === "discarded") {
        // A knock on the keys, not a word: keep waiting for the player to speak.
        isSpeaking = false;
        onSpeaking(false);
        if (timedOut) sendRecording();
      }
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(context.destination);
    void context.resume();
    onOpen();
  });
}
