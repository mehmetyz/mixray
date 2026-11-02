"use client";

import { useState } from "react";
import { keyLabel, playableStemUrls, tempoLabel } from "@/lib/studio/format";
import {
  encodeStandardMidi,
  encodeStoreZip,
  formatSessionNotes,
  triggerBrowserDownload,
  type ZipFileEntry,
} from "@/lib/studio/export-pack";
import { ScreenHeading } from "./ScreenHeading";
import { useStudio } from "./StudioContext";

type PackItemId = "soundWav" | "restWav" | "midi" | "recipe";

type PackSelection = Record<PackItemId, boolean>;

type PackItem = {
  id: PackItemId;
  title: string;
  description: string;
  files: string[];
};

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "mixray_sound"
  );
}

/** Names a file after what it really holds: a sound can be served as WAV or as MP3. */
function audioExtension(url: string): string {
  return new URL(url, "http://local").pathname.toLowerCase().endsWith(".mp3") ? "mp3" : "wav";
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch asset (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function TakeHomeView() {
  const { trackMap, selectedIsolation } = useStudio();

  const [selected, setSelected] = useState<PackSelection>({
    soundWav: true,
    restWav: true,
    midi: true,
    recipe: true,
  });
  const [bundling, setBundling] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const label = selectedIsolation?.label ?? "The sound";
  const stemSlug = slugify(selectedIsolation?.label ?? "isolated_sound");
  const soundUrl = selectedIsolation?.sound_wav_url ?? selectedIsolation?.sound_url ?? "";
  const soundFile = `${stemSlug}_sound.${audioExtension(soundUrl)}`;
  const restFile = `${stemSlug}_rest.${audioExtension(selectedIsolation?.rest_url ?? "")}`;
  const hasNotes = (selectedIsolation?.notes.length ?? 0) > 0;
  const hasRecipe = selectedIsolation?.recipe !== undefined;

  const items: PackItem[] = [
    {
      id: "soundWav",
      title: label,
      description: "This sound on its own, for the whole clip.",
      files: [soundFile],
    },
    {
      id: "restWav",
      title: "Rest of the mix",
      description: "Everything else in the clip, without this sound. Play along with it.",
      files: [restFile],
    },
  ];
  if (hasNotes) {
    items.push({
      id: "midi",
      title: "MIDI notes",
      description:
        "Easy is one melody line moved into a comfortable range. Intermediate adds the chord root and fifth for the left hand.",
      files: [`${stemSlug}_easy.mid`, `${stemSlug}_intermediate.mid`],
    });
  }
  items.push({
    id: "recipe",
    title: hasRecipe ? "Sound recipe and session notes" : "Session notes",
    description: hasRecipe
      ? "Synth settings suggested by Muse Spark Open as a starting point, plus the tempo, key and each bar's chord."
      : "The tempo, key and each bar's chord.",
    files: [
      ...(hasRecipe ? [`${stemSlug}_recipe.json`] : []),
      `${stemSlug}_session_notes.txt`,
    ],
  });

  const chosenFiles = items.filter((item) => selected[item.id]).flatMap((item) => item.files);

  const toggleItem = (id: PackItemId) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const downloadBundleZip = async () => {
    if (selectedIsolation === undefined || chosenFiles.length === 0) return;
    setBundling(true);
    setStatusMessage(null);

    try {
      const stems = playableStemUrls(trackMap, selectedIsolation, soundUrl);

      const entries: ZipFileEntry[] = [];
      const encoder = new TextEncoder();

      if (selected.soundWav) {
        entries.push({ filename: soundFile, data: await fetchBytes(stems.soundUrl) });
      }
      if (selected.restWav) {
        entries.push({ filename: restFile, data: await fetchBytes(stems.restUrl) });
      }
      if (selected.midi && hasNotes) {
        const { easy, intermediate } = selectedIsolation.arrangements;
        entries.push({
          filename: `${stemSlug}_easy.mid`,
          data: new Uint8Array(encodeStandardMidi(easy, trackMap.tempo.bpm)),
        });
        entries.push({
          filename: `${stemSlug}_intermediate.mid`,
          data: new Uint8Array(encodeStandardMidi(intermediate ?? easy, trackMap.tempo.bpm)),
        });
      }
      if (selected.recipe) {
        if (hasRecipe) {
          entries.push({
            filename: `${stemSlug}_recipe.json`,
            data: encoder.encode(JSON.stringify(selectedIsolation.recipe, null, 2)),
          });
        }
        entries.push({
          filename: `${stemSlug}_session_notes.txt`,
          data: encoder.encode(formatSessionNotes(trackMap, selectedIsolation)),
        });
      }

      const zipBuffer = encodeStoreZip(entries);
      triggerBrowserDownload(
        new Blob([zipBuffer], { type: "application/zip" }),
        `${slugify(trackMap.source.title)}_${stemSlug}_pack.zip`,
      );
      setStatusMessage(`Downloaded ${entries.length} files.`);
    } catch (error: unknown) {
      setStatusMessage(error instanceof Error ? error.message : "Could not build the download.");
    } finally {
      setBundling(false);
    }
  };

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg lg:overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-6 p-5 md:p-8">
        <ScreenHeading title="Take it to your DAW">
          <p className="text-sm text-text-2">
            {tempoLabel(trackMap.tempo)}, {keyLabel(trackMap.key)}. All files
            start at the same moment, so they line up when placed at the same position.
          </p>
        </ScreenHeading>

        <div className="divide-y divide-line rounded-card border border-line bg-surface">
          {items.map((item) => (
            <label
              key={item.id}
              className="flex cursor-pointer items-start gap-3 p-4 hover:bg-surface-2/40"
            >
              <input
                type="checkbox"
                checked={selected[item.id]}
                onChange={() => toggleItem(item.id)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded-icon border-control bg-bg accent-text"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-text">{item.title}</span>
                <span className="mt-0.5 block text-sm text-text-2">{item.description}</span>
                <span className="mono-num mt-1.5 block truncate text-xs text-muted">
                  {item.files.join(", ")}
                </span>
              </span>
            </label>
          ))}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <span role="status" className="text-sm text-muted">
            {statusMessage}
          </span>
          <button
            type="button"
            disabled={chosenFiles.length === 0 || bundling || selectedIsolation === undefined}
            onClick={() => void downloadBundleZip()}
            className="h-10 cursor-pointer rounded-full bg-text px-5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {bundling ? "Building the ZIP…" : `Download ZIP, ${chosenFiles.length} files`}
          </button>
        </div>
      </div>
    </section>
  );
}
