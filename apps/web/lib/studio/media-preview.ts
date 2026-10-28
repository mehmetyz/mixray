export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_MEDIA_SECONDS = 360;

export type MediaKind = "audio" | "video";

export type MediaPreview = {
  kind: MediaKind;
  duration: number;
  peaks: number[];
  thumbnails: string[];
};

export class MediaValidationError extends Error {
  override name = "MediaValidationError";
}

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".webm", ".m4v"] as const;

export function detectMediaKind(file: File): MediaKind {
  if (file.type.startsWith("video/")) return "video";
  const lower = file.name.toLowerCase();
  if (VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "video";
  return "audio";
}

function computePeaks(buffer: AudioBuffer, bucketCount: number): number[] {
  const channel = buffer.getChannelData(0);
  const total = channel.length;
  if (total === 0) return Array.from({ length: bucketCount }, () => 0.25);

  const blockSize = Math.max(1, Math.floor(total / bucketCount));
  const raw: number[] = [];
  let maxPeak = 0.01;

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = bucket * blockSize;
    const end = Math.min(total, start + blockSize);
    let peak = 0;
    for (let idx = start; idx < end; idx += 4) {
      const abs = Math.abs(channel[idx] ?? 0);
      if (abs > peak) peak = abs;
    }
    raw.push(peak);
    if (peak > maxPeak) maxPeak = peak;
  }

  return raw.map((value) => Math.max(0.06, Math.min(0.98, value / maxPeak)));
}

function syntheticPeaks(bucketCount: number): number[] {
  const out: number[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const val = 0.2 + 0.55 * Math.abs(Math.sin(index * 0.21)) * (0.65 + 0.35 * Math.cos(index * 0.53));
    out.push(val);
  }
  return out;
}

type DecodedPeaks = {
  duration: number;
  peaks: number[];
};

type VideoFrameCapture = {
  duration: number;
  thumbnails: string[];
};

async function decodePeaksFromFile(file: File, bucketCount: number): Promise<DecodedPeaks | null> {
  const bytes = await file.arrayBuffer().catch(() => null);
  if (bytes === null) return null;
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes).catch(() => null);
    if (decoded === null) return null;
    return {
      duration: decoded.duration,
      peaks: computePeaks(decoded, bucketCount),
    };
  } finally {
    await context.close();
  }
}

async function captureVideoFrames(file: File, frameCount: number): Promise<VideoFrameCapture> {
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;
  video.src = objectUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new MediaValidationError("Could not read that video file."));
    });

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new MediaValidationError("The video has no readable duration.");
    }

    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext("2d");
    const thumbnails: string[] = [];

    if (ctx !== null) {
      for (let index = 0; index < frameCount; index += 1) {
        const targetTime = Math.min(duration - 0.05, ((index + 0.5) / frameCount) * duration);
        video.currentTime = Math.max(0, targetTime);
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          video.addEventListener("seeked", done, { once: true });
          window.setTimeout(done, 400);
        });
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        thumbnails.push(canvas.toDataURL("image/jpeg", 0.65));
      }
    }

    return { duration, thumbnails };
  } finally {
    video.src = "";
    URL.revokeObjectURL(objectUrl);
  }
}

/** Validates file size and length (≤ 50 MB, ≤ 6 min) and extracts waveform peaks + video filmstrip. */
export async function inspectMediaFile(file: File, bucketCount = 140): Promise<MediaPreview> {
  if (file.size <= 0) {
    throw new MediaValidationError("That file is empty.");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new MediaValidationError("Files can be at most 50 MB.");
  }

  const kind = detectMediaKind(file);
  if (kind === "video") {
    const { duration, thumbnails } = await captureVideoFrames(file, 8);
    if (duration > MAX_MEDIA_SECONDS) {
      throw new MediaValidationError("Media can be at most 6 minutes long.");
    }
    const audioDecoded = await decodePeaksFromFile(file, bucketCount);
    return {
      kind: "video",
      duration,
      peaks: audioDecoded?.peaks ?? syntheticPeaks(bucketCount),
      thumbnails,
    };
  }

  const decoded = await decodePeaksFromFile(file, bucketCount);
  if (decoded === null) {
    throw new MediaValidationError("Could not decode audio. Use MP3, WAV, FLAC, M4A, MP4 or MOV.");
  }
  if (decoded.duration > MAX_MEDIA_SECONDS) {
    throw new MediaValidationError("Media can be at most 6 minutes long.");
  }

  return {
    kind: "audio",
    duration: decoded.duration,
    peaks: decoded.peaks,
    thumbnails: [],
  };
}
