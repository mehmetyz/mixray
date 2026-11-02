export type DemoVideoSource =
  | { kind: "embed"; url: string }
  | { kind: "file"; url: string };

const YOUTUBE_ID = /(?:youtu\.be\/|youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/))([\w-]{6,})/;

/** Reads `MIXRAY_DEMO_VIDEO_URL`. The section stays off the page until there is a video to show. */
export function demoVideoSource(url: string | undefined): DemoVideoSource | null {
  const trimmed = url?.trim();
  if (trimmed === undefined || !trimmed.startsWith("https://")) return null;
  const youtubeId = trimmed.match(YOUTUBE_ID)?.[1];
  if (youtubeId !== undefined) return { kind: "embed", url: `https://www.youtube-nocookie.com/embed/${youtubeId}` };
  return { kind: "file", url: trimmed };
}
