// Puts each demo's video and a still of it into apps/web/public/demos. A demo is only a shortcut:
// clicking it uploads this video through the normal Add flow. AI-generated videos get a visible
// watermark burned in.
//
// Usage: node scripts/build_demos.mjs <engine-url>
import { execFileSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CLIPS } from "../apps/web/lib/demos.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PUBLIC_DEMOS = path.join(ROOT, "apps/web/public/demos");
const WATERMARK = "AI-generated video (Google Flow)";
const WATERMARK_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";
const POSTER_SECONDS = "2";

// The engine clip each demo's video is taken from: the clips first uploaded from the original files.
const SOURCES = {
  "cafe-piano": "49a9e75eb32c84b443092d1e8f9bd88d229568550443fafbbc7514ba4d860610",
  "park-song": "fb051765b8772103359c98222f28fd41e67a75f80e05572c218c9722ace94144",
  "busker-dog-taxi": "d0b653cd9da0ca36473c89bef87a7c72a3b077f54d4cbf1089a6e35c34e64ad7",
  "rooftop-singer": "4c900f25ef313ccfac255f4d7752ec56016bd4c0ea9c67ccda9613ef31151cdb",
  "rainy-piano": "745943abfd51bdb7cb778d4725f365d3e841950d2ba4c553badb562e47c9e995",
  "navy-band-funk": "f0486cff43730f5ed2a1890631079a9313f593388c6d4f0d8affb1672a209d43",
};

const engineUrl = process.argv[2]?.replace(/\/$/, "");
if (!engineUrl) {
  console.error("Usage: node scripts/build_demos.mjs <engine-url>");
  process.exit(1);
}

function assetUrl(relative) {
  const clean = relative.replace(/^\//, "");
  return `${engineUrl}/${clean.startsWith("files/") ? clean : `files/${clean}`}`;
}

async function download(relative, destination) {
  const response = await fetch(assetUrl(relative));
  if (!response.ok) throw new Error(`${response.status} for ${relative}`);
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

function encodeVideo(input, output, watermark) {
  const filters = watermark
    ? [
        "-vf",
        `drawtext=fontfile=${WATERMARK_FONT}:text='${WATERMARK}':fontcolor=white@0.92:fontsize=h*0.034:` +
          "box=1:boxcolor=black@0.5:boxborderw=12:x=w-tw-28:y=28",
      ]
    : [];
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-i", input, ...filters,
    "-c:v", "libx264", "-crf", "23", "-preset", "medium", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart", output,
  ]);
}

for (const demo of DEMO_CLIPS) {
  const directory = path.join(PUBLIC_DEMOS, demo.id);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  const raw = path.join(directory, "raw.mp4");
  await download(`files/clips/${SOURCES[demo.id]}/video.mp4`, raw);
  encodeVideo(raw, path.join(directory, "video.mp4"), demo.origin === "ai");
  await rm(raw);
  // The home page shows this frame; it comes from the watermarked video, so the mark shows too.
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-ss", POSTER_SECONDS, "-i", path.join(directory, "video.mp4"),
    "-frames:v", "1", "-vf", "scale=640:-2", "-q:v", "4", path.join(directory, "poster.jpg"),
  ]);
  console.log(`${demo.id}: video.mp4, poster.jpg`);
}
