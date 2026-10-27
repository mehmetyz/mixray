const RIFF_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8;
const PCM_FORMAT = 1;
const INT16_MAX = 32767;
const INT16_MIN = -32768;

/** De-interleaved audio: one Float32Array of samples per channel, all the same length. */
export type AudioChannels = {
  channels: Float32Array[];
  sampleRate: number;
};

export class InvalidAudioError extends Error {
  override name = "InvalidAudioError";
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

function toInt16(sample: number): number {
  const scaled = Math.round(sample * INT16_MAX);
  return Math.min(Math.max(scaled, INT16_MIN), INT16_MAX);
}

/** 16-bit PCM WAV. Written by hand because the browser can decode audio but not encode it. */
export function encodeWav({ channels, sampleRate }: AudioChannels): ArrayBuffer {
  const first = channels[0];
  if (first === undefined) throw new InvalidAudioError("The clip has no audio channels.");
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new InvalidAudioError("The clip has no usable sample rate.");
  }
  const frames = first.length;
  for (const channel of channels) {
    if (channel.length !== frames) {
      throw new InvalidAudioError("The audio channels have different lengths.");
    }
  }

  const channelCount = channels.length;
  const dataBytes = frames * channelCount * BYTES_PER_SAMPLE;
  const buffer = new ArrayBuffer(RIFF_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, RIFF_HEADER_BYTES - 8 + dataBytes, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, PCM_FORMAT, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * BYTES_PER_SAMPLE, true);
  view.setUint16(32, channelCount * BYTES_PER_SAMPLE, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);

  let offset = RIFF_HEADER_BYTES;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      const sample = channel[frame];
      view.setInt16(offset, toInt16(sample ?? 0), true);
      offset += BYTES_PER_SAMPLE;
    }
  }

  return buffer;
}
