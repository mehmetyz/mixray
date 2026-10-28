"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ChangeEvent, type DragEvent, type MouseEvent } from "react";
import { clipSeconds, clipWindow, MAX_CLIP_SECONDS, type ClipWindow } from "@/lib/audio/clip";
import { trimToClip } from "@/lib/audio/trim";
import { startIsolation, uploadClip, waitForJob } from "@/lib/engine/client";
import type { JobStage } from "@/lib/engine/types";
import { formatClockSeconds } from "@/lib/studio/format";
import { inspectMediaFile, type MediaPreview } from "@/lib/studio/media-preview";
import { ScreenHeading } from "./ScreenHeading";

type UploadState = "idle" | "inspecting" | "trimming" | "uploading" | "isolating" | "polling";

type VideoTapPoint = {
  x: number;
  y: number;
};

const SUGGESTION_QUICK_PRESETS: readonly string[] = [
  "Piano",
  "Vocals",
  "Bass",
  "Lead synth",
  "Drums",
  "Guitar",
  "Violin",
];

const STAGE_STEPS: readonly JobStage[] = ["listening", "isolating", "analyzing"];

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export function ClipPicker() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoObjectUrl, setVideoObjectUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const [windowRange, setWindowRange] = useState<ClipWindow>({ start: 0, end: MAX_CLIP_SECONDS });
  const [promptInput, setPromptInput] = useState<string>("");
  const [videoTapPoint, setVideoTapPoint] = useState<VideoTapPoint | null>(null);
  const [rightsChecked, setRightsChecked] = useState<boolean>(true);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [previewPlaying, setPreviewPlaying] = useState<boolean>(false);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [activeStage, setActiveStage] = useState<JobStage>("listening");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      previewAudioRef.current?.pause();
      previewAudioRef.current = null;
      if (videoObjectUrl !== null) {
        URL.revokeObjectURL(videoObjectUrl);
      }
    };
  }, [videoObjectUrl]);

  const stopLocalPreview = () => {
    if (previewAudioRef.current !== null) {
      previewAudioRef.current.pause();
      previewAudioRef.current.src = "";
      previewAudioRef.current = null;
    }
    setPreviewPlaying(false);
  };

  const handleFileChosen = async (file: File) => {
    stopLocalPreview();
    setErrorMessage(null);
    setUploadState("inspecting");
    if (videoObjectUrl !== null) {
      URL.revokeObjectURL(videoObjectUrl);
      setVideoObjectUrl(null);
    }
    setVideoTapPoint(null);

    try {
      const inspected = await inspectMediaFile(file);
      const initialWindow = clipWindow({
        start: 0,
        duration: MAX_CLIP_SECONDS,
        fileDuration: inspected.duration,
      });
      setSelectedFile(file);
      setPreview(inspected);
      setWindowRange(initialWindow);
      if (inspected.kind === "video") {
        setVideoObjectUrl(URL.createObjectURL(file));
      }
    } catch (error: unknown) {
      setSelectedFile(null);
      setPreview(null);
      setErrorMessage(error instanceof Error ? error.message : "Could not read that file.");
    } finally {
      setUploadState("idle");
    }
  };

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file !== undefined) {
      void handleFileChosen(file);
    }
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file !== undefined) {
      void handleFileChosen(file);
    }
  };

  const handleStartChange = (nextStart: number) => {
    if (preview === null) return;
    stopLocalPreview();
    const span = clipSeconds(windowRange);
    setWindowRange(
      clipWindow({
        start: nextStart,
        duration: span,
        fileDuration: preview.duration,
      }),
    );
  };

  const handleLengthChange = (nextDuration: number) => {
    if (preview === null) return;
    stopLocalPreview();
    setWindowRange(
      clipWindow({
        start: windowRange.start,
        duration: nextDuration,
        fileDuration: preview.duration,
      }),
    );
  };

  const toggleLocalPreview = () => {
    if (selectedFile === null) return;
    if (previewPlaying) {
      stopLocalPreview();
      return;
    }
    const url = URL.createObjectURL(selectedFile);
    const audio = new Audio(url);
    audio.currentTime = windowRange.start;
    audio.ontimeupdate = () => {
      if (audio.currentTime >= windowRange.end) {
        audio.pause();
        URL.revokeObjectURL(url);
        setPreviewPlaying(false);
      }
    };
    audio.onended = () => {
      URL.revokeObjectURL(url);
      setPreviewPlaying(false);
    };
    previewAudioRef.current = audio;
    void audio
      .play()
      .then(() => setPreviewPlaying(true))
      .catch(() => {
        URL.revokeObjectURL(url);
        setPreviewPlaying(false);
      });
  };

  const handleVideoTap = (event: MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const xPct = Math.round(((event.clientX - rect.left) / rect.width) * 100);
    const yPct = Math.round(((event.clientY - rect.top) / rect.height) * 100);
    setVideoTapPoint({ x: xPct, y: yPct });
    if (promptInput.trim().length === 0) {
      setPromptInput(`musician at ${xPct}%, ${yPct}%`);
    }
  };

  const handleSubmit = async () => {
    if (selectedFile === null || preview === null || !rightsChecked) return;
    stopLocalPreview();
    setErrorMessage(null);

    const initialPrompt = promptInput.trim();

    try {
      const title = stripExtension(selectedFile.name);
      let job;

      if (preview.kind === "audio") {
        setUploadState("trimming");
        const trimmed = await trimToClip({
          file: selectedFile,
          start: windowRange.start,
          duration: clipSeconds(windowRange),
        });
        setUploadState("uploading");
        job = await uploadClip({
          blob: trimmed.blob,
          filename: `${title}.wav`,
          clipStart: 0,
          clipEnd: clipSeconds(trimmed.window),
          title,
        });
      } else {
        setUploadState("uploading");
        job = await uploadClip({
          blob: selectedFile,
          filename: selectedFile.name,
          clipStart: windowRange.start,
          clipEnd: windowRange.end,
          title,
        });
      }

      if (job.status !== "done") {
        setUploadState("polling");
        setActiveStage(job.stage);
        job = await waitForJob(job.id, {
          onStage: (updated) => setActiveStage(updated.stage),
        });
      }

      if (initialPrompt.length > 0) {
        setUploadState("isolating");
        const isoJob = await startIsolation({
          jobId: job.id,
          prompt: initialPrompt,
          label: initialPrompt,
        });
        let finishedIso = isoJob;
        if (isoJob.status !== "done") {
          finishedIso = await waitForJob(job.id, {
            onStage: (updated) => setActiveStage(updated.stage),
          });
        }
        if (finishedIso.isolationId !== null) {
          router.push(
            `/c/${encodeURIComponent(job.id)}/pick?iso=${encodeURIComponent(finishedIso.isolationId)}`,
          );
          return;
        }
      }

      router.push(`/c/${encodeURIComponent(job.id)}/pick`);
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error ? error.message : "Upload failed. Check your connection and try again.",
      );
      setUploadState("idle");
    }
  };

  const busy = uploadState !== "idle";
  const maxStart = preview !== null ? Math.max(0, preview.duration - clipSeconds(windowRange)) : 0;
  const windowLeftPct =
    preview !== null && preview.duration > 0 ? (windowRange.start / preview.duration) * 100 : 0;
  const windowWidthPct =
    preview !== null && preview.duration > 0
      ? Math.min(100 - windowLeftPct, (clipSeconds(windowRange) / preview.duration) * 100)
      : 100;

  return (
    <div className="max-w-3xl space-y-5">
      <ScreenHeading
        step="add"
        title="Point at a sound. Hear it alone."
      >
        <p className="text-xs text-text-2">
          Add audio or video, pick the part you want, and choose which instrument or musician to isolate.
        </p>
      </ScreenHeading>

      {errorMessage !== null ? (
        <div
          role="alert"
          className="rounded-card border border-accent bg-surface px-4 py-2.5 text-xs text-text"
        >
          <span className="mono-num mr-2 font-semibold uppercase text-accent">Error</span>
          {errorMessage}
        </div>
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,video/*,.mp3,.wav,.flac,.m4a,.ogg,.mp4,.mov,.webm"
        onChange={onInputChange}
        className="sr-only"
        id="media-upload-input"
      />

      {selectedFile === null || preview === null ? (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={() => setDragActive(false)}
          onDrop={onDrop}
          className={`rounded-card border border-dashed p-8 text-center transition ${
            dragActive ? "border-accent bg-surface" : "border-control bg-inset hover:border-text-2"
          }`}
        >
          <p className="text-sm font-medium text-text">
            {uploadState === "inspecting"
              ? "Reading media..."
              : "Drop your song or video here"}
          </p>
          <p className="mono-num mt-1 text-xs text-muted">
            MP3 · WAV · FLAC · MP4 · MOV · up to 50 MB
          </p>
          <div className="mt-4">
            <label
              htmlFor="media-upload-input"
              className="inline-flex h-8 cursor-pointer items-center rounded-icon bg-text px-4 text-xs font-semibold text-bg transition hover:opacity-90"
            >
              Choose file
            </label>
          </div>
        </div>
      ) : (
        <div className="space-y-4 rounded-card border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="mono-num rounded-icon border border-line-2 bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-text-2">
                {preview.kind}
              </span>
              <span className="truncate font-medium text-text">{selectedFile.name}</span>
              <span className="mono-num text-muted">({formatClockSeconds(preview.duration)})</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleLocalPreview}
                className="mono-num h-7 cursor-pointer rounded-icon border border-line-2 bg-bg px-2.5 text-xs text-text-2 hover:border-control hover:text-text"
              >
                {previewPlaying ? "Stop" : "Preview"}
              </button>
              <label
                htmlFor="media-upload-input"
                className="mono-num flex h-7 cursor-pointer items-center rounded-icon border border-line-2 bg-bg px-2 text-xs text-muted hover:text-text"
              >
                Replace
              </label>
            </div>
          </div>

          {preview.kind === "video" && videoObjectUrl !== null ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs">
                <span className="text-text-2">
                  {videoTapPoint !== null
                    ? `Point picked: ${videoTapPoint.x}%, ${videoTapPoint.y}%`
                    : "Tap the musician/instrument in the video to isolate:"}
                </span>
                {videoTapPoint !== null ? (
                  <button
                    type="button"
                    onClick={() => setVideoTapPoint(null)}
                    className="text-[11px] text-muted hover:text-text"
                  >
                    Clear tap
                  </button>
                ) : null}
              </div>
              <div
                onClick={handleVideoTap}
                className="relative aspect-video w-full cursor-crosshair overflow-hidden rounded-well border border-line bg-inset select-none"
              >
                <video
                  ref={videoElementRef}
                  src={videoObjectUrl}
                  muted
                  playsInline
                  className="h-full w-full object-cover"
                />
                {videoTapPoint !== null ? (
                  <div
                    style={{ left: `${videoTapPoint.x}%`, top: `${videoTapPoint.y}%` }}
                    className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                  >
                    <div className="h-6 w-6 rounded-full border-2 border-accent bg-accent/20 animate-ping" />
                    <div className="absolute inset-1.5 rounded-full bg-accent" />
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {preview.thumbnails.length > 0 && preview.kind !== "video" ? (
            <div
              aria-label="Video filmstrip preview"
              className="grid grid-cols-8 gap-1 overflow-hidden rounded-well border border-line bg-inset p-1"
            >
              {preview.thumbnails.map((src, index) => (
                // eslint-disable-next-line @next/next/no-img-element -- local canvas data URL
                <img
                  key={index}
                  src={src}
                  alt={`Frame ${index + 1}`}
                  className="aspect-video w-full rounded-xs object-cover opacity-85"
                />
              ))}
            </div>
          ) : null}

          <div
            role="img"
            aria-label={`Selected clip window from ${formatClockSeconds(windowRange.start)} to ${formatClockSeconds(windowRange.end)}`}
            className="relative h-14 overflow-hidden rounded-well border border-line bg-inset flex items-center px-1"
          >
            <div className="flex h-full w-full items-center gap-px">
              {preview.peaks.map((peak, idx) => (
                <div
                  key={idx}
                  style={{ height: `${Math.max(12, Math.round(peak * 82))}%` }}
                  className="flex-1 rounded-xs bg-inactive"
                />
              ))}
            </div>
            <div
              style={{ left: `${windowLeftPct}%`, width: `${windowWidthPct}%` }}
              className="pointer-events-none absolute inset-y-1 flex items-start justify-between rounded-xs border border-accent bg-surface-2/40 px-1.5 py-0.5"
            >
              <span className="mono-num rounded-xs bg-bg px-1 text-[10px] text-text">
                {formatClockSeconds(windowRange.start)}
              </span>
              <span className="mono-num rounded-xs bg-bg px-1 text-[10px] text-accent">
                {clipSeconds(windowRange).toFixed(1)}s
              </span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-xs text-text-2">
              <span className="flex justify-between">
                <span>Start offset</span>
                <span className="mono-num text-text">
                  {formatClockSeconds(windowRange.start)} → {formatClockSeconds(windowRange.end)}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={Math.max(0, Number(maxStart.toFixed(1)))}
                step={0.5}
                value={windowRange.start}
                disabled={maxStart <= 0 || busy}
                onChange={(event) => handleStartChange(Number(event.target.value))}
                className="w-full cursor-pointer"
              />
            </label>

            <label className="space-y-1 text-xs text-text-2">
              <span className="flex justify-between">
                <span>Clip length</span>
                <span className="mono-num text-accent">{clipSeconds(windowRange).toFixed(1)}s</span>
              </span>
              <input
                type="range"
                min={Math.min(5, preview.duration)}
                max={Math.min(MAX_CLIP_SECONDS, preview.duration)}
                step={1}
                value={clipSeconds(windowRange)}
                disabled={preview.duration <= 5 || busy}
                onChange={(event) => handleLengthChange(Number(event.target.value))}
                className="w-full cursor-pointer"
              />
            </label>
          </div>

          <div className="space-y-2 border-t border-line pt-3">
            <label htmlFor="target-sound-input" className="block text-xs font-medium text-text">
              What sound do you want to isolate?
            </label>
            <div className="flex gap-2">
              <input
                id="target-sound-input"
                type="text"
                value={promptInput}
                onChange={(event) => setPromptInput(event.target.value)}
                placeholder="e.g. piano chords, synth lead, vocals, bass"
                disabled={busy}
                className="mono-num h-8 flex-1 rounded-icon border border-line-2 bg-inset px-2.5 text-xs text-text placeholder:text-muted focus:border-text focus:outline-none"
              />
            </div>
            <div className="flex flex-wrap gap-1.5 pt-0.5">
              {SUGGESTION_QUICK_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={busy}
                  onClick={() => setPromptInput(preset)}
                  className="cursor-pointer rounded-icon border border-line-2 bg-bg px-2 py-0.5 text-[11px] text-text-2 hover:border-control hover:text-text disabled:opacity-50"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {selectedFile !== null ? (
        <div className="space-y-3 rounded-card border border-line bg-surface p-4">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              checked={rightsChecked}
              onChange={(event) => setRightsChecked(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 rounded-icon border-control bg-bg accent-text"
            />
            <span className="text-xs text-muted leading-relaxed">
              I own this media or have rights to use it. Processed with Meta SAM &amp; Muse.
            </span>
          </label>

          {busy && uploadState !== "inspecting" ? (
            <div className="mono-num flex flex-wrap items-center gap-2 rounded-well border border-line bg-inset px-3 py-2 text-xs">
              {uploadState === "trimming" ? (
                <span className="text-accent">Trimming clip...</span>
              ) : uploadState === "uploading" ? (
                <span className="text-accent">Uploading to engine...</span>
              ) : uploadState === "isolating" ? (
                <span className="text-accent">
                  Isolating &quot;{promptInput}&quot; with SAM Audio...
                </span>
              ) : (
                STAGE_STEPS.map((stage, index) => (
                  <span key={stage} className="flex items-center gap-2">
                    {index > 0 ? <span className="text-muted">→</span> : null}
                    <span
                      className={stage === activeStage ? "font-semibold text-accent" : "text-muted"}
                    >
                      {stage}
                    </span>
                  </span>
                ))
              )}
            </div>
          ) : null}

          <div className="flex items-center justify-between pt-1">
            <span className="mono-num text-xs text-muted">
              {promptInput.trim().length > 0
                ? `Will isolate "${promptInput.trim()}"`
                : "Will open in studio"}
            </span>
            <button
              type="button"
              disabled={selectedFile === null || !rightsChecked || busy}
              onClick={() => void handleSubmit()}
              className="h-8 cursor-pointer rounded-icon bg-text px-4 text-xs font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
            >
              {busy ? "Working..." : promptInput.trim().length > 0 ? "Isolate & Analyze →" : "Analyze →"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
