export const DEMO_CLIP_IDS = [
  "cafe-piano",
  "park-song",
  "busker-dog-taxi",
  "rooftop-singer",
  "rainy-piano",
  "navy-band-funk",
] as const;

export type DemoClipId = (typeof DEMO_CLIP_IDS)[number];

/** Whether the picture and the music were made by a model or recorded from real people. */
export type DemoOrigin = "ai" | "real";

export type DemoClip = {
  id: DemoClipId;
  title: string;
  origin: DemoOrigin;
  /** The sound separated as soon as the demo is added, as if typed on Add. */
  prompt: string;
  /** What the demo shows, in one line. */
  shows: string;
  /** Who made the video, shown wherever it plays. */
  credit: string;
  license: string;
  sourceUrl?: string;
};

export const DEMO_ORIGIN_LABELS: Record<DemoOrigin, string> = {
  ai: "AI-generated",
  real: "Real recording",
};

const FLOW_CREDIT = "Video and music generated with Google Flow for Mixray";
const FLOW_LICENSE = "AI-generated and marked as such; not under the repository's code licence";

/**
 * Shortcuts to Add: a demo is a video in `public/demos` that goes through the same upload, analysis
 * and separation as any clip, with its sound already typed in.
 */
export const DEMO_CLIPS: readonly DemoClip[] = [
  {
    id: "cafe-piano",
    prompt: "piano",
    title: "Piano and espresso steam",
    origin: "ai",
    shows: "Pull the piano out from under a loud steam hiss, then learn its notes.",
    credit: FLOW_CREDIT,
    license: FLOW_LICENSE,
  },
  {
    id: "park-song",
    prompt: "vocals",
    title: "Song in the park",
    origin: "ai",
    shows: "Take the voice out of a song with an acoustic guitar and birdsong.",
    credit: FLOW_CREDIT,
    license: FLOW_LICENSE,
  },
  {
    id: "busker-dog-taxi",
    prompt: "acoustic guitar",
    title: "Busker, dog and taxi",
    origin: "ai",
    shows: "Hear a street guitar alone, without the dog or the passing taxi.",
    credit: FLOW_CREDIT,
    license: FLOW_LICENSE,
  },
  {
    id: "rooftop-singer",
    prompt: "vocals",
    title: "Rooftop singer",
    origin: "ai",
    shows: "Take the voice out of a dance track on a rooftop.",
    credit: FLOW_CREDIT,
    license: FLOW_LICENSE,
  },
  {
    id: "rainy-piano",
    prompt: "piano",
    title: "Piano on a rainy night",
    origin: "ai",
    shows: "Learn a quiet solo piano by a rainy window.",
    credit: FLOW_CREDIT,
    license: FLOW_LICENSE,
  },
  {
    id: "navy-band-funk",
    prompt: "bass",
    title: "The Washington Post, funk version",
    origin: "real",
    shows: "Take the bass out of a real seven-piece band.",
    credit: "U.S. Navy Band Cruisers, arranged by Musician 1st Class Trevor Shifflett",
    license: "Public domain: U.S. federal government work; march by John Philip Sousa, 1889",
    sourceUrl:
      "https://commons.wikimedia.org/wiki/File:Sousa_gone_Funk_(Washington_Post)_-_U.S._Navy_Band.webm",
  },
];

export function findDemoClip(id: string | undefined): DemoClip | undefined {
  return DEMO_CLIPS.find((demo) => demo.id === id);
}
