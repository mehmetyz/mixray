import { readFile } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import type { FallbackStem, Isolation, TrackMap, Video, VideoTrack } from "./trackmap.generated";
import { parseTrackMap } from "./validate";

export const DEMO_CLIP_IDS = ["demo1"] as const;

export type DemoClipId = (typeof DEMO_CLIP_IDS)[number];

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export function isDemoClipId(id: string): id is DemoClipId {
  return DEMO_CLIP_IDS.some((demoId) => demoId === id);
}

function resolveEngineAssetUrl(rawUrl: string | undefined, engineUrl: string): string | undefined {
  if (rawUrl === undefined || rawUrl.length === 0) return rawUrl;
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) return rawUrl;
  const clean = rawUrl.replace(/^\//, "");
  return clean.startsWith("files/") ? `${engineUrl}/${clean}` : `${engineUrl}/files/${clean}`;
}

function normalizeIsolationUrls(iso: Isolation, engineUrl: string): Isolation {
  return {
    ...iso,
    sound_url: resolveEngineAssetUrl(iso.sound_url, engineUrl) ?? iso.sound_url,
    sound_wav_url: resolveEngineAssetUrl(iso.sound_wav_url, engineUrl),
    rest_url: resolveEngineAssetUrl(iso.rest_url, engineUrl) ?? iso.rest_url,
  };
}

function normalizeFallbackUrls(stem: FallbackStem, engineUrl: string): FallbackStem {
  return {
    ...stem,
    url: resolveEngineAssetUrl(stem.url, engineUrl) ?? stem.url,
    wav_url: resolveEngineAssetUrl(stem.wav_url, engineUrl),
  };
}

function normalizeVideoUrls(video: Video, engineUrl: string): Video {
  const tracks: VideoTrack[] = video.tracks.map((track) => ({
    ...track,
    masks_url: resolveEngineAssetUrl(track.masks_url, engineUrl) ?? track.masks_url,
  }));
  return {
    ...video,
    url: resolveEngineAssetUrl(video.url, engineUrl) ?? video.url,
    tracks,
  };
}

function normalizeEngineTrackMap(trackMap: TrackMap, engineUrl: string): TrackMap {
  return {
    ...trackMap,
    source: {
      ...trackMap.source,
      mix_url: resolveEngineAssetUrl(trackMap.source.mix_url, engineUrl),
    },
    isolations: trackMap.isolations.map((iso) => normalizeIsolationUrls(iso, engineUrl)),
    fallback_stems: trackMap.fallback_stems?.map((stem) => normalizeFallbackUrls(stem, engineUrl)),
    video:
      trackMap.video === undefined ? undefined : normalizeVideoUrls(trackMap.video, engineUrl),
  };
}

/** Loads a precomputed demo TrackMap from disk, or a live SHA-256 clip TrackMap from Modal. */
export const loadTrackMap = cache(async (clipId: string): Promise<TrackMap | null> => {
  if (isDemoClipId(clipId)) {
    const file = path.join(process.cwd(), "public", "demos", clipId, "trackmap.json");
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    return parseTrackMap(data);
  }

  if (!SHA256_HEX_PATTERN.test(clipId)) return null;

  const engineUrl = process.env.MIXRAY_ENGINE_URL?.trim().replace(/\/$/, "");
  if (engineUrl === undefined || engineUrl.length === 0) return null;

  const response = await fetch(`${engineUrl}/files/clips/${clipId}/trackmap.json`, {
    cache: "no-store",
  }).catch(() => null);

  if (response === null || !response.ok) return null;

  const payload: unknown = await response.json().catch(() => null);
  if (payload === null) return null;

  return normalizeEngineTrackMap(parseTrackMap(payload), engineUrl);
});
