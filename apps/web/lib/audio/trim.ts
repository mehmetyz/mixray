import { clipSeconds, clipWindow, type ClipWindow } from "./clip";
import { encodeWav } from "./wav";

export type TrimRequest = {
  file: File;
  start: number;
  duration: number;
};

export type TrimResult = {
  blob: Blob;
  window: ClipWindow;
  sampleRate: number;
  channelCount: number;
};

export class UnreadableAudioError extends Error {
  override name = "UnreadableAudioError";
}

/** Decodes the file, cuts the chosen window and re-encodes it, so only the clip leaves the device. */
export async function trimToClip({ file, start, duration }: TrimRequest): Promise<TrimResult> {
  const bytes = await file.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes).catch(() => null);
    if (decoded === null) {
      throw new UnreadableAudioError("That file could not be read as audio.");
    }

    const window = clipWindow({ start, duration, fileDuration: decoded.duration });
    const firstFrame = Math.round(window.start * decoded.sampleRate);
    const frames = Math.round(clipSeconds(window) * decoded.sampleRate);
    const channels: Float32Array[] = [];
    for (let index = 0; index < decoded.numberOfChannels; index += 1) {
      channels.push(decoded.getChannelData(index).slice(firstFrame, firstFrame + frames));
    }

    return {
      blob: new Blob([encodeWav({ channels, sampleRate: decoded.sampleRate })], {
        type: "audio/wav",
      }),
      window,
      sampleRate: decoded.sampleRate,
      channelCount: channels.length,
    };
  } finally {
    await context.close();
  }
}
