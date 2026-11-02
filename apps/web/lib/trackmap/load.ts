import { cache } from "react";
import type { FallbackStem, Isolation, TrackMap, Video, VideoTrack } from "./trackmap.generated";
import { parseTrackMap } from "./validate";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

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

/** Loads a clip's TrackMap from Modal. */
export const loadTrackMap = cache(async (clipId: string): Promise<TrackMap | null> => {
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
