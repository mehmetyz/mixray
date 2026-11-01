import { SpeechGate } from "./vad";
import { encodeWav } from "./wav";

const TARGET_SAMPLE_RATE = 16_000;
const PROCESSOR_BUFFER_SIZE = 4_096;
const ROOM_SECONDS = 0.3;
const EARCON_SECONDS = 0.2;
const LISTEN_SECONDS = 5;
const DEAD_MICROPHONE_LEVEL = 0.0005;

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
      recording.push(chunk);
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
