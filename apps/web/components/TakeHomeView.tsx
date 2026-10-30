"use client";

import { useState } from "react";
import { resolvePlayableStems } from "@/lib/studio/demo-audio";
import {
  encodeStandardMidi,
  encodeStoreZip,
  formatSessionNotes,
  triggerBrowserDownload,
  type ZipFileEntry,
} from "@/lib/studio/export-pack";
import { methodBadgeLabel } from "@/lib/studio/format";
import { RecipeCard } from "./RecipeCard";
import { ScreenHeading } from "./ScreenHeading";
import { useStudio } from "./StudioContext";
import { TimelineRuler } from "./StudioShell";

type PackItemId = "soundWav" | "restWav" | "midi" | "recipe";

type PackSelection = Record<PackItemId, boolean>;

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "mixray_sound"
  );
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch asset (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export function TakeHomeView() {
  const { trackMap, selectedIsolation, useDemucsCleaner, fallbackAlternative } = useStudio();

  const [selected, setSelected] = useState<PackSelection>({
    soundWav: true,
    restWav: true,
    midi: true,
    recipe: true,
  });
  const [bundling, setBundling] = useState<boolean>(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const selectedCount = Object.values(selected).filter(Boolean).length;
  const stemSlug = slugify(selectedIsolation?.label ?? "isolated_sound");

  const toggleItem = (id: PackItemId) => {
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const downloadSingleMidi = () => {
    if (selectedIsolation === undefined) return;
    const midiBuf = encodeStandardMidi(selectedIsolation.arrangements.easy, trackMap.tempo.bpm);
    triggerBrowserDownload(new Blob([midiBuf], { type: "audio/midi" }), `${stemSlug}_easy.mid`);
  };

  const downloadSingleRecipe = () => {
    if (selectedIsolation === undefined) return;
    const payload = JSON.stringify(selectedIsolation.recipe ?? {}, null, 2);
    triggerBrowserDownload(
      new Blob([payload], { type: "application/json" }),
      `${stemSlug}_recipe.json`,
    );
  };

  const downloadBundleZip = async () => {
    if (selectedIsolation === undefined || selectedCount === 0) return;
    setBundling(true);
    setStatusMessage(null);

    const soundOverride =
      useDemucsCleaner && fallbackAlternative !== null
        ? (fallbackAlternative.wav_url ?? fallbackAlternative.url)
        : (selectedIsolation.sound_wav_url ?? selectedIsolation.sound_url);

    let revoke: () => void = () => {};
    try {
      const resolved = await resolvePlayableStems(trackMap, selectedIsolation, soundOverride);
      revoke = resolved.revoke;

      const entries: ZipFileEntry[] = [];
      const encoder = new TextEncoder();

      if (selected.soundWav) {
        entries.push({
          filename: `${stemSlug}_sound.wav`,
          data: await fetchBytes(resolved.soundUrl),
        });
      }
      if (selected.restWav) {
        entries.push({
          filename: `${stemSlug}_rest.wav`,
          data: await fetchBytes(resolved.restUrl),
        });
      }
      if (selected.midi) {
        const easyMidi = encodeStandardMidi(
          selectedIsolation.arrangements.easy,
          trackMap.tempo.bpm,
        );
        entries.push({
          filename: `${stemSlug}_easy.mid`,
          data: new Uint8Array(easyMidi),
        });
        if (selectedIsolation.arrangements.intermediate !== undefined) {
          const interMidi = encodeStandardMidi(
            selectedIsolation.arrangements.intermediate,
            trackMap.tempo.bpm,
          );
          entries.push({
            filename: `${stemSlug}_intermediate.mid`,
            data: new Uint8Array(interMidi),
          });
        }
      }
      if (selected.recipe) {
        entries.push({
          filename: `${stemSlug}_recipe.json`,
          data: encoder.encode(JSON.stringify(selectedIsolation.recipe ?? {}, null, 2)),
        });
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
      setStatusMessage(`Exported ${entries.length} files in ZIP archive.`);
    } catch (error: unknown) {
      setStatusMessage(
        error instanceof Error ? error.message : "Could not build ZIP bundle right now.",
      );
    } finally {
      revoke();
      setBundling(false);
    }
  };

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col bg-bg lg:overflow-y-auto">
        <TimelineRuler />

        <div className="w-full max-w-3xl mx-auto space-y-6 p-5 md:p-8">
          <ScreenHeading step="take" title="Rebuild it in your DAW.">
            <p className="text-xs text-text-2">
              Aligned at {Math.round(trackMap.tempo.bpm)} BPM in {trackMap.key.tonic}{" "}
              {trackMap.key.mode}. Drop stems and MIDI onto bar 1.
            </p>
          </ScreenHeading>

          <div className="divide-y divide-line rounded-card border border-line bg-surface">
            <label className="flex cursor-pointer items-center justify-between gap-4 p-4 hover:bg-surface-2/40">
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected.soundWav}
                  onChange={() => toggleItem("soundWav")}
                  className="h-4 w-4 rounded-icon border-control bg-bg accent-text"
                />
                <span>
                  <span className="block text-sm font-medium text-text">
                    The sound ({stemSlug}_sound.wav)
                  </span>
                  <span className="block text-xs text-muted">
                    Isolated stem ·{" "}
                    {selectedIsolation !== undefined
                      ? methodBadgeLabel(selectedIsolation.method, useDemucsCleaner)
                      : "WAV"}
                  </span>
                </span>
              </span>
              <span className="mono-num text-xs text-muted">WAV</span>
            </label>

            <label className="flex cursor-pointer items-center justify-between gap-4 p-4 hover:bg-surface-2/40">
              <span className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected.restWav}
                  onChange={() => toggleItem("restWav")}
                  className="h-4 w-4 rounded-icon border-control bg-bg accent-text"
                />
                <span>
                  <span className="block text-sm font-medium text-text">
                    Rest of the mix ({stemSlug}_rest.wav)
                  </span>
                  <span className="block text-xs text-muted">
                    Backing stem without the picked sound for play-along
                  </span>
                </span>
              </span>
              <span className="mono-num text-xs text-muted">WAV</span>
            </label>

            <div className="flex items-center justify-between gap-4 p-4 hover:bg-surface-2/40">
              <label className="flex flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected.midi}
                  onChange={() => toggleItem("midi")}
                  className="h-4 w-4 rounded-icon border-control bg-bg accent-text"
                />
                <span>
                  <span className="block text-sm font-medium text-text">
                    MIDI arrangements (Easy &amp; Intermediate)
                  </span>
                  <span className="block text-xs text-muted">
                    Beat-snapped Standard MIDI Files at {Math.round(trackMap.tempo.bpm)} BPM
                  </span>
                </span>
              </label>
              <button
                type="button"
                onClick={downloadSingleMidi}
                className="mono-num h-7 cursor-pointer rounded-icon border border-line-2 bg-bg px-2.5 text-xs text-text-2 hover:border-control hover:text-text"
              >
                .MID
              </button>
            </div>

            <div className="flex items-center justify-between gap-4 p-4 hover:bg-surface-2/40">
              <label className="flex flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected.recipe}
                  onChange={() => toggleItem("recipe")}
                  className="h-4 w-4 rounded-icon border-control bg-bg accent-text"
                />
                <span>
                  <span className="block text-sm font-medium text-text">
                    Sound recipe + chord &amp; tempo notes
                  </span>
                  <span className="block text-xs text-muted">
                    Muse Spark Open synth parameters (.json) and bar chords (.txt)
                  </span>
                </span>
              </label>
              <button
                type="button"
                onClick={downloadSingleRecipe}
                className="mono-num h-7 cursor-pointer rounded-icon border border-line-2 bg-bg px-2.5 text-xs text-text-2 hover:border-control hover:text-text"
              >
                .JSON
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="mono-num text-xs text-muted">
              {statusMessage ?? `${selectedCount} item${selectedCount === 1 ? "" : "s"} selected`}
            </span>
            <button
              type="button"
              disabled={selectedCount === 0 || bundling || selectedIsolation === undefined}
              onClick={() => void downloadBundleZip()}
              className="h-9 cursor-pointer rounded-icon bg-text px-5 text-xs font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
            >
              {bundling ? "Building ZIP..." : `Download · ${selectedCount} files`}
            </button>
          </div>
        </div>
      </section>

      <aside className="flex w-full shrink-0 flex-col gap-5 border-t border-line bg-surface p-4 lg:w-80 lg:border-t-0 lg:border-l lg:overflow-y-auto">
        <div>
          <span className="eyebrow mb-2 block">Session specs</span>
          <div className="mono-num space-y-2 rounded-well border border-line bg-inset p-3 text-xs">
            <div className="flex justify-between">
              <span className="text-muted">Clip</span>
              <span className="truncate text-text">{trackMap.source.title}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Tempo / Key</span>
              <span className="text-text">
                {Math.round(trackMap.tempo.bpm)} BPM · {trackMap.key.tonic} {trackMap.key.mode}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Sound</span>
              <span className="text-accent">{selectedIsolation?.label ?? "—"}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted">Transcribed</span>
              <span className="text-text">{selectedIsolation?.notes.length ?? 0} notes</span>
            </div>
          </div>
        </div>

        <div className="border-t border-line pt-4">
          <RecipeCard recipe={selectedIsolation?.recipe} compact />
          <p className="mt-2 text-[11px] leading-relaxed text-muted">
            Starting points for Vital or any subtractive synth. Tune by ear against the isolated
            stem.
          </p>
        </div>
      </aside>
    </>
  );
}
