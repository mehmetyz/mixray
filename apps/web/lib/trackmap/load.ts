import { readFile } from "node:fs/promises";
import path from "node:path";
import { cache } from "react";
import type { TrackMap } from "./trackmap.generated";
import { parseTrackMap } from "./validate";

export const DEMO_CLIP_IDS = ["demo1"] as const;

export type DemoClipId = (typeof DEMO_CLIP_IDS)[number];

export function isDemoClipId(id: string): id is DemoClipId {
  return DEMO_CLIP_IDS.some((demoId) => demoId === id);
}

/** Returns null for unknown clips; throws if a known clip's trackmap breaks the schema. */
export const loadTrackMap = cache(async (clipId: string): Promise<TrackMap | null> => {
  if (!isDemoClipId(clipId)) return null;
  const file = path.join(process.cwd(), "public", "demos", clipId, "trackmap.json");
  const data: unknown = JSON.parse(await readFile(file, "utf8"));
  return parseTrackMap(data);
});
