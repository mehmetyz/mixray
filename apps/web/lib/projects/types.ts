import type { DemoClipId } from "@/lib/demos";
import type { JobStage } from "@/lib/engine/types";

export type ProjectKind = "audio" | "video";

/**
 * A clip this browser added: only what is needed to list it. Whether its work is running, done or
 * failed is asked from the engine each time, never stored here.
 */
export type SoundList = {
  isolations: readonly { id: string }[];
};

export type ProjectRecord = {
  /** The engine's clip id. */
  id: string;
  title: string;
  kind: ProjectKind;
  /** Clip length in seconds (max 30). */
  duration: number;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  /** When the current separation started, so a reopened page shows the real time spent. */
  processingSince?: number;
  /** The separation began from a drawn area, so Muse Spark names it first. */
  usesArea?: boolean;
  bpm?: number;
  /** Tonic and mode, e.g. "A minor". */
  key?: string;
  activePrompt?: string;
  isolatedSoundLabel?: string;
  /**
   * The sounds this browser asked for. A clip is shared by everyone who adds it, so without this
   * its list would show what others separated. Absent on clips added before this existed.
   */
  soundIds?: string[];
  /** Added from a demo card, so the studio can show its label and credit. */
  demoId?: DemoClipId;
};

/** Only the sounds this browser asked for; they still come at once if someone made them before. */
export function soundsAskedFor<Map extends SoundList>(trackMap: Map, soundIds: readonly string[] | undefined): Map {
  if (soundIds === undefined) return trackMap;
  return { ...trackMap, isolations: trackMap.isolations.filter((sound) => soundIds.includes(sound.id)) };
}

/** The steps a separation goes through, in order, for showing where it is. */
export function separationSteps(project: ProjectRecord): readonly JobStage[] {
  return project.usesArea === true ? ["naming", "isolating", "analyzing"] : ["isolating", "analyzing"];
}
