"use client";

import { useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { clipSeconds, clipWindow, MAX_CLIP_SECONDS, type ClipWindow } from "@/lib/audio/clip";
import { trimToClip } from "@/lib/audio/trim";
import {
  getStoredVideo,
  startAreaIsolation,
  startIsolation,
  uploadClip,
  waitForJob,
} from "@/lib/engine/client";
import type { JobStage } from "@/lib/engine/types";
import {
  MIN_DRAG_PIXELS,
  scaleVideoArea,
  videoAreaFromDrag,
  type PixelSize,
  type StagePoint,
  type VideoArea,
} from "@/lib/studio/area";
import { formatClockSeconds } from "@/lib/studio/format";
import { inspectMediaFile, type MediaPreview } from "@/lib/studio/media-preview";
import { ScreenHeading } from "./ScreenHeading";

type UploadState =
  | "idle"
  | "inspecting"
  | "trimming"
  | "uploading"
  | "isolating"
  | "polling"
  | "routing";

type PipelineStage = {
  step: number;
  label: string;
  detail: string;
};

type DragMode = "move" | "resize-left" | "resize-right";

type AreaDrag = {
  start: StagePoint;
  end: StagePoint;
};

type PickedArea = {
  area: VideoArea;
  source: PixelSize;
  time: number;
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

function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

export function ClipPicker() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const videoElementRef = useRef<HTMLVideoElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [videoObjectUrl, setVideoObjectUrl] = useState<string | null>(null);
  const [areaDrag, setAreaDrag] = useState<AreaDrag | null>(null);
  const [pickedArea, setPickedArea] = useState<PickedArea | null>(null);
  const [audioObjectUrl, setAudioObjectUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<MediaPreview | null>(null);
  const [windowRange, setWindowRange] = useState<ClipWindow>({ start: 0, end: MAX_CLIP_SECONDS });
  const [playbackTime, setPlaybackTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isScrubbing, setIsScrubbing] = useState<boolean>(false);

  const [promptInput, setPromptInput] = useState<string>("");
  const [projectTitle, setProjectTitle] = useState<string>("");
  const [rightsChecked, setRightsChecked] = useState<boolean>(true);
  const [dragActive, setDragActive] = useState<boolean>(false);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [activeStage, setActiveStage] = useState<JobStage>("listening");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0);

  const [isDragging, setIsDragging] = useState<boolean>(false);
  const wasDraggingRef = useRef<boolean>(false);
  const dragSessionRef = useRef<{
    mode: DragMode;
    startX: number;
    initialStart: number;
    initialEnd: number;
    fileDuration: number;
    timelineWidth: number;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (previewAudioRef.current !== null) {
        previewAudioRef.current.pause();
        previewAudioRef.current = null;
      }
      if (videoObjectUrl !== null) {
        URL.revokeObjectURL(videoObjectUrl);
      }
      if (audioObjectUrl !== null) {
        URL.revokeObjectURL(audioObjectUrl);
      }
    };
  }, [videoObjectUrl, audioObjectUrl]);

  const getActiveMediaElement = (): HTMLMediaElement | null => {
    if (preview?.kind === "video") {
      return videoElementRef.current;
    }
    return previewAudioRef.current;
  };

  const stopPlayback = () => {
    const media = getActiveMediaElement();
    if (media !== null) {
      media.pause();
    }
    setIsPlaying(false);
  };

  const togglePlay = () => {
    const media = getActiveMediaElement();
    if (media === null) return;

    if (isPlaying) {
      media.pause();
      setIsPlaying(false);
    } else {
      if (media.currentTime < windowRange.start || media.currentTime >= windowRange.end) {
        media.currentTime = windowRange.start;
        setPlaybackTime(windowRange.start);
      }
      void media
        .play()
        .then(() => setIsPlaying(true))
        .catch(() => setIsPlaying(false));
    }
  };

  const seekPlayback = (seconds: number) => {
    const dur = preview?.duration ?? 0;
    const clamped = Math.max(0, Math.min(dur, seconds));
    setPlaybackTime(clamped);
    const media = getActiveMediaElement();
    if (media !== null) {
      media.currentTime = clamped;
    }
  };

  const toggleMute = () => {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);
    const media = getActiveMediaElement();
    if (media !== null) {
      media.muted = nextMuted;
    }
  };

  const handleMediaTimeUpdate = () => {
    if (isScrubbing) return;
    const media = getActiveMediaElement();
    if (media === null) return;
    const cur = media.currentTime;
    setPlaybackTime(cur);

    if (cur >= (preview?.duration ?? 0)) {
      media.currentTime = 0;
      setPlaybackTime(0);
      setIsPlaying(false);
    }
  };

  const pointOnStage = (event: ReactPointerEvent<HTMLDivElement>): StagePoint => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const finishAreaDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const element = videoElementRef.current;
    if (areaDrag === null || element === null) return;
    const end = pointOnStage(event);
    if (Math.hypot(end.x - areaDrag.start.x, end.y - areaDrag.start.y) < MIN_DRAG_PIXELS) {
      setAreaDrag(null);
      togglePlay();
      return;
    }
    setAreaDrag({ start: areaDrag.start, end });
    if (isPlaying) togglePlay();
    const stage = event.currentTarget.getBoundingClientRect();
    const picture = element.getBoundingClientRect();
    const shiftX = stage.left - picture.left;
    const shiftY = stage.top - picture.top;
    const source = { width: element.videoWidth, height: element.videoHeight };
    setPickedArea({
      area: videoAreaFromDrag(
        { x: areaDrag.start.x + shiftX, y: areaDrag.start.y + shiftY },
        { x: end.x + shiftX, y: end.y + shiftY },
        { width: picture.width, height: picture.height },
        source,
      ),
      source,
      time: element.currentTime,
    });
  };

  const handleFileChosen = async (file: File) => {
    setAreaDrag(null);
    setPickedArea(null);
    stopPlayback();
    setErrorMessage(null);
    setUploadState("inspecting");
    if (videoObjectUrl !== null) {
      URL.revokeObjectURL(videoObjectUrl);
      setVideoObjectUrl(null);
    }
    if (audioObjectUrl !== null) {
      URL.revokeObjectURL(audioObjectUrl);
      setAudioObjectUrl(null);
    }
    setPlaybackTime(0);

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
      setProjectTitle(stripExtension(file.name));
      if (inspected.kind === "video") {
        setVideoObjectUrl(URL.createObjectURL(file));
      } else {
        setAudioObjectUrl(URL.createObjectURL(file));
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

  const handlePointerDown = (
    mode: DragMode,
    event: React.PointerEvent<HTMLDivElement>,
  ) => {
    if (preview === null || timelineRef.current === null) return;
    event.stopPropagation();
    event.preventDefault();

    const rect = timelineRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;

    dragSessionRef.current = {
      mode,
      startX: event.clientX,
      initialStart: windowRange.start,
      initialEnd: windowRange.end,
      fileDuration: preview.duration,
      timelineWidth: rect.width,
    };
    wasDraggingRef.current = false;
    setIsDragging(true);
  };

  useEffect(() => {
    if (!isDragging) return;

    const onGlobalPointerMove = (e: PointerEvent) => {
      const session = dragSessionRef.current;
      if (session === null) return;

      const deltaX = e.clientX - session.startX;
      if (Math.abs(deltaX) > 2) {
        wasDraggingRef.current = true;
      }
      const deltaSec = (deltaX / session.timelineWidth) * session.fileDuration;

      if (session.mode === "move") {
        const span = session.initialEnd - session.initialStart;
        const maxStart = Math.max(0, session.fileDuration - span);
        const nextStart = Math.max(0, Math.min(maxStart, session.initialStart + deltaSec));
        setWindowRange({
          start: Number(nextStart.toFixed(2)),
          end: Number((nextStart + span).toFixed(2)),
        });
      } else if (session.mode === "resize-left") {
        const minStart = Math.max(0, session.initialEnd - MAX_CLIP_SECONDS);
        const maxStart = Math.max(0, session.initialEnd - 3.0);
        const nextStart = Math.max(minStart, Math.min(maxStart, session.initialStart + deltaSec));
        setWindowRange({
          start: Number(nextStart.toFixed(2)),
          end: session.initialEnd,
        });
      } else if (session.mode === "resize-right") {
        const minEnd = Math.min(session.fileDuration, session.initialStart + 3.0);
        const maxEnd = Math.min(session.fileDuration, session.initialStart + MAX_CLIP_SECONDS);
        const nextEnd = Math.max(minEnd, Math.min(maxEnd, session.initialEnd + deltaSec));
        setWindowRange({
          start: session.initialStart,
          end: Number(nextEnd.toFixed(2)),
        });
      }
    };

    const onGlobalPointerUp = () => {
      dragSessionRef.current = null;
      setIsDragging(false);
      setTimeout(() => {
        wasDraggingRef.current = false;
      }, 150);
    };

    window.addEventListener("pointermove", onGlobalPointerMove);
    window.addEventListener("pointerup", onGlobalPointerUp);
    window.addEventListener("pointercancel", onGlobalPointerUp);

    return () => {
      window.removeEventListener("pointermove", onGlobalPointerMove);
      window.removeEventListener("pointerup", onGlobalPointerUp);
      window.removeEventListener("pointercancel", onGlobalPointerUp);
    };
  }, [isDragging]);

  const handleTimelineClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (wasDraggingRef.current || isDragging || preview === null || timelineRef.current === null) {
      return;
    }
    const rect = timelineRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const clickSec = ratio * preview.duration;
    seekPlayback(clickSec);
  };

  const handleSubmit = async () => {
    if (selectedFile === null || preview === null || !rightsChecked) return;
    stopPlayback();
    setErrorMessage(null);

    const initialPrompt = promptInput.trim();
    setElapsedSeconds(0);

    try {
      const title = (projectTitle.trim() || stripExtension(selectedFile.name)).trim();
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

      setUploadState("polling");
      const finished = await waitForJob(job.id, {
        onStage: (j) => setActiveStage(j.stage),
      });

      if (finished.status === "error") {
        throw new Error(finished.error ?? "Processing failed on engine.");
      }

      if (pickedArea !== null) {
        setUploadState("isolating");
        const stored = await getStoredVideo(job.trackmapUrl);
        const lastFrame = Math.floor(clipSeconds(windowRange) * stored.fps) - 1;
        const frame = Math.round((pickedArea.time - windowRange.start) * stored.fps);
        await startAreaIsolation({
          jobId: job.id,
          area: scaleVideoArea(pickedArea.area, pickedArea.source, stored),
          frame: Math.min(lastFrame, Math.max(0, frame)),
        });
        await waitForJob(job.id, {
          onStage: (j) => setActiveStage(j.stage),
        });
      } else if (initialPrompt.length > 0) {
        setUploadState("isolating");
        await startIsolation({ jobId: job.id, prompt: initialPrompt });
        await waitForJob(job.id, {
          onStage: (j) => setActiveStage(j.stage),
        });
      }

      setUploadState("routing");
      router.push(`/c/${encodeURIComponent(job.id)}/pick`);
    } catch (error: unknown) {
      setErrorMessage(
        error instanceof Error ? error.message : "Upload failed. Check your connection and try again.",
      );
      setElapsedSeconds(0);
      setUploadState("idle");
    }
  };

  const busy = uploadState !== "idle";

  useEffect(() => {
    if (!busy) return;
    const interval = setInterval(() => {
      setElapsedSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [busy]);

  const currentStepIndex = useMemo<number>(() => {
    switch (uploadState) {
      case "trimming":
        return 0;
      case "uploading":
        return 1;
      case "polling":
        return activeStage === "isolating" ? 3 : 2;
      case "isolating":
        return 3;
      case "routing":
        return 4;
      default:
        return 0;
    }
  }, [uploadState, activeStage]);

  const pipelineStages = useMemo<readonly PipelineStage[]>(() => {
    const hasPrompt = promptInput.trim().length > 0;
    return [
      {
        step: 1,
        label: "Prepare Clip",
        detail: "Trimming selected window",
      },
      {
        step: 2,
        label: "Upload Audio",
        detail: "Sending audio to engine",
      },
      {
        step: 3,
        label: "Analyze Track",
        detail: "Detecting tempo, beats & chords",
      },
      {
        step: 4,
        label: hasPrompt ? `Isolate "${promptInput.trim()}"` : "Stem Separation",
        detail: hasPrompt
          ? "Separating chosen instrument"
          : "Preparing reference waveforms",
      },
      {
        step: 5,
        label: "Open Studio",
        detail: "Opening DAW workspace",
      },
    ];
  }, [promptInput]);

  const windowLeftPct =
    preview !== null && preview.duration > 0 ? (windowRange.start / preview.duration) * 100 : 0;
  const windowWidthPct =
    preview !== null && preview.duration > 0
      ? Math.min(100 - windowLeftPct, (clipSeconds(windowRange) / preview.duration) * 100)
      : 100;

  return (
    <div className="w-full max-w-3xl mx-auto space-y-4">
      <ScreenHeading
        step="add"
        title="Point at a sound. Hear it alone."
      >
        <p className="text-sm text-text-2">
          Add audio or video, select your 30s section, and isolate any instrument or player.
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
          className={`rounded-card border border-dashed p-10 text-center transition ${
            dragActive ? "border-accent bg-surface" : "border-control bg-surface-2/40 hover:border-text-2"
          }`}
        >
          <p className="text-base font-semibold text-text">
            {uploadState === "inspecting"
              ? "Reading media..."
              : "Drop your song or video here"}
          </p>
          <p className="mono-num mt-1 text-xs text-muted">
            MP3 · WAV · FLAC · MP4 · MOV · up to 50 MB
          </p>
          <div className="mt-5">
            <label
              htmlFor="media-upload-input"
              className="inline-flex h-10 cursor-pointer items-center rounded-full bg-text px-5 text-sm font-semibold text-bg shadow-sm transition hover:opacity-90 active:scale-[0.98]"
            >
              Choose file
            </label>
          </div>
        </div>
      ) : busy ? (
        <div className="space-y-3 rounded-card border border-line bg-surface p-4">
          <div className="flex items-center justify-between border-b border-line pb-2.5">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="mono-num rounded-icon border border-line-2 bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-text-2">
                {preview.kind}
              </span>
              <span className="truncate font-semibold text-text">{selectedFile.name}</span>
            </div>
            <span className="mono-num text-[11px] text-muted shrink-0">
              {elapsedSeconds > 0 ? `${elapsedSeconds}s · ` : ""}Stage {currentStepIndex + 1} of{" "}
              {pipelineStages.length}
            </span>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75"></span>
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-accent"></span>
                </span>
                <span className="font-semibold text-text">
                  {pipelineStages[currentStepIndex]?.label ?? "Processing track"}
                </span>
              </div>
              <span className="mono-num text-xs text-accent">
                {Math.round(((currentStepIndex + 1) / pipelineStages.length) * 100)}%
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-inset">
              <div
                className="h-full bg-accent transition-all duration-500 ease-out"
                style={{
                  width: `${((currentStepIndex + 1) / pipelineStages.length) * 100}%`,
                }}
              />
            </div>
          </div>

          {/* Compact 5-step horizontal stepper */}
          <div className="grid grid-cols-5 gap-1.5 py-1">
            {pipelineStages.map((stage, idx) => {
              const isCompleted = idx < currentStepIndex;
              const isActive = idx === currentStepIndex;
              return (
                <div
                  key={stage.step}
                  className={`flex flex-col items-center justify-center rounded-icon border px-1.5 py-1 text-center transition ${
                    isActive
                      ? "border-accent bg-accent/10 text-text"
                      : isCompleted
                        ? "border-line-2 bg-surface-2 text-text opacity-70"
                        : "border-transparent bg-inset text-muted"
                  }`}
                >
                  <span className="mono-num text-[10px]">
                    {isCompleted ? "✓" : `0${stage.step}`}
                  </span>
                  <span className="truncate text-[10px] font-medium max-w-full">
                    {stage.label.split(" ")[0]}
                  </span>
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between border-t border-line pt-2.5 text-xs">
            <span className="mono-num flex items-center gap-2 text-[11px] text-muted">
              <span className="h-1.5 w-1.5 animate-ping rounded-full bg-accent"></span>
              {pipelineStages[currentStepIndex]?.detail}... {elapsedSeconds > 0 ? `(${elapsedSeconds}s)` : "Please wait"}
            </span>
            <button
              type="button"
              onClick={() => {
                setElapsedSeconds(0);
                setUploadState("idle");
              }}
              className="cursor-pointer text-[11px] text-muted hover:text-text"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3 rounded-card border border-line bg-surface p-3.5">
          {/* Top File Info Bar */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 text-xs">
              <span className="mono-num rounded-icon border border-line-2 bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-text-2">
                {preview.kind}
              </span>
              <span className="truncate font-medium text-text">{selectedFile.name}</span>
              <span className="mono-num text-muted">({formatClockSeconds(preview.duration)})</span>
            </div>
            <label
              htmlFor="media-upload-input"
              className="mono-num flex h-6 cursor-pointer items-center rounded-icon border border-line-2 bg-bg px-2 text-[11px] text-muted hover:text-text"
            >
              Replace
            </label>
          </div>

          {/* Video Player */}
          {preview.kind === "video" && videoObjectUrl !== null ? (
            <div className="relative overflow-hidden rounded-well border border-line bg-black">
              <div
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  const point = pointOnStage(event);
                  setPickedArea(null);
                  setAreaDrag({ start: point, end: point });
                }}
                onPointerMove={(event) => {
                  if (areaDrag !== null && pickedArea === null) {
                    setAreaDrag({ start: areaDrag.start, end: pointOnStage(event) });
                  }
                }}
                onPointerUp={finishAreaDrag}
                onPointerCancel={() => setAreaDrag(null)}
                className="relative aspect-video max-h-52 w-full touch-none cursor-crosshair select-none mx-auto flex items-center justify-center bg-black/90"
                title={isPlaying ? "Pause" : "Play"}
              >
                <video
                  ref={videoElementRef}
                  src={videoObjectUrl}
                  muted={isMuted}
                  playsInline
                  onTimeUpdate={handleMediaTimeUpdate}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  className="h-full max-h-52 w-auto object-contain"
                />
                {areaDrag !== null ? (
                  <div
                    className="pointer-events-none absolute rounded-xs border border-accent bg-accent/15"
                    style={{
                      left: Math.min(areaDrag.start.x, areaDrag.end.x),
                      top: Math.min(areaDrag.start.y, areaDrag.end.y),
                      width: Math.abs(areaDrag.end.x - areaDrag.start.x),
                      height: Math.abs(areaDrag.end.y - areaDrag.start.y),
                    }}
                  />
                ) : null}
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-line-2 bg-surface px-3 py-1.5 text-[11px] text-muted">
                <span>
                  {pickedArea !== null
                    ? `Area selected at ${formatClockSeconds(pickedArea.time)}. Mixray will isolate what is in it.`
                    : "Drag over the instrument on the video to pick its sound. Click to play or pause."}
                </span>
                {pickedArea !== null ? (
                  <button
                    type="button"
                    onClick={() => {
                      setPickedArea(null);
                      setAreaDrag(null);
                    }}
                    className="shrink-0 cursor-pointer text-text-2 hover:text-text"
                  >
                    Clear
                  </button>
                ) : null}
              </div>

              {/* Video Player Transport Controls Bar */}
              <div className="flex flex-nowrap items-center gap-3 border-t border-line-2 bg-surface px-3 py-2 text-xs">
                <button
                  type="button"
                  onClick={togglePlay}
                  className="mono-num flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-icon border border-line-2 bg-bg text-text transition hover:border-control"
                  title={isPlaying ? "Pause (Space)" : "Play (Space)"}
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? (
                    <span className="text-[10px] font-bold">❚❚</span>
                  ) : (
                    <span className="ml-0.5 text-[11px]">▶</span>
                  )}
                </button>

                <span className="mono-num shrink-0 text-[11px] text-text-2">
                  {formatClockSeconds(playbackTime)} / {formatClockSeconds(preview.duration)}
                </span>

                {/* Video Scrubber Slider */}
                <div className="flex-1 min-w-0 flex items-center">
                  <input
                    type="range"
                    min={0}
                    max={preview.duration}
                    step={0.1}
                    value={playbackTime}
                    onPointerDown={() => setIsScrubbing(true)}
                    onPointerUp={() => setIsScrubbing(false)}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      seekPlayback(val);
                    }}
                    className="w-full h-1.5 cursor-pointer accent-accent bg-inset rounded-full"
                    aria-label="Seek video playback"
                  />
                </div>

                {/* Mute Icon on the Right */}
                <button
                  type="button"
                  onClick={toggleMute}
                  className="mono-num shrink-0 flex h-7 w-7 cursor-pointer items-center justify-center rounded-icon border border-line-2 bg-bg text-muted transition hover:border-control hover:text-text"
                  title={isMuted ? "Unmute" : "Mute"}
                  aria-label={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? (
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <line x1="23" y1="9" x2="17" y2="15" />
                      <line x1="17" y1="9" x2="23" y2="15" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          ) : null}

          {/* Audio Player */}
          {preview.kind !== "video" ? (
            <div className="rounded-well border border-line bg-surface p-2.5">
              <audio
                ref={previewAudioRef}
                src={audioObjectUrl ?? undefined}
                muted={isMuted}
                onTimeUpdate={handleMediaTimeUpdate}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
              />
              <div className="flex flex-nowrap items-center gap-3 text-xs">
                <button
                  type="button"
                  onClick={togglePlay}
                  className="mono-num flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-icon border border-line-2 bg-bg text-text transition hover:border-control"
                  title={isPlaying ? "Pause (Space)" : "Play (Space)"}
                  aria-label={isPlaying ? "Pause" : "Play"}
                >
                  {isPlaying ? (
                    <span className="text-[10px] font-bold">❚❚</span>
                  ) : (
                    <span className="ml-0.5 text-[11px]">▶</span>
                  )}
                </button>

                <span className="mono-num shrink-0 text-[11px] text-text-2">
                  {formatClockSeconds(playbackTime)} / {formatClockSeconds(preview.duration)}
                </span>

                {/* Audio Scrubber Slider */}
                <div className="flex-1 min-w-0 flex items-center">
                  <input
                    type="range"
                    min={0}
                    max={preview.duration}
                    step={0.1}
                    value={playbackTime}
                    onPointerDown={() => setIsScrubbing(true)}
                    onPointerUp={() => setIsScrubbing(false)}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      seekPlayback(val);
                    }}
                    className="w-full h-1.5 cursor-pointer accent-accent bg-inset rounded-full"
                    aria-label="Seek audio playback"
                  />
                </div>

                {/* Mute Icon on the Right */}
                <button
                  type="button"
                  onClick={toggleMute}
                  className="mono-num shrink-0 flex h-7 w-7 cursor-pointer items-center justify-center rounded-icon border border-line-2 bg-bg text-muted transition hover:border-control hover:text-text"
                  title={isMuted ? "Unmute" : "Mute"}
                  aria-label={isMuted ? "Unmute" : "Mute"}
                >
                  {isMuted ? (
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <line x1="23" y1="9" x2="17" y2="15" />
                      <line x1="17" y1="9" x2="23" y2="15" />
                    </svg>
                  ) : (
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                    </svg>
                  )}
                </button>
              </div>
            </div>
          ) : null}

          {/* Interactive Drag & Drop Waveform Timeline (30s Window Trimmer) */}
          <div className="space-y-1 pt-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-text-2">
                Selected clip:{" "}
                <span className="mono-num font-medium text-text">
                  {formatClockSeconds(windowRange.start)} → {formatClockSeconds(windowRange.end)}
                </span>
                <span className="mono-num ml-1 text-accent">
                  ({clipSeconds(windowRange).toFixed(1)}s)
                </span>
              </span>
              <span className="text-[10px] text-muted">
                Drag window to move · Drag edges to resize
              </span>
            </div>

            <div
              ref={timelineRef}
              role="region"
              aria-label="Timeline selection window"
              onClick={handleTimelineClick}
              className="relative h-12 w-full cursor-pointer select-none overflow-hidden rounded-well border border-line bg-inset flex items-center px-0.5"
            >
              {/* Peaks Bars */}
              <div className="pointer-events-none flex h-full w-full items-center gap-px">
                {preview.peaks.map((peak, idx) => (
                  <div
                    key={idx}
                    style={{ height: `${Math.max(10, Math.round(peak * 80))}%` }}
                    className="flex-1 rounded-xs bg-inactive"
                  />
                ))}
              </div>

              {/* Current Playhead Needle */}
              {preview.duration > 0 ? (
                <div
                  style={{ left: `${(playbackTime / preview.duration) * 100}%` }}
                  className="pointer-events-none absolute inset-y-0 w-0.5 bg-text z-20"
                />
              ) : null}

              {/* Draggable Selection Window */}
              <div
                style={{ left: `${windowLeftPct}%`, width: `${windowWidthPct}%` }}
                onPointerDown={(e) => handlePointerDown("move", e)}
                className="absolute inset-y-0.5 flex cursor-grab items-center justify-between rounded-xs border-2 border-accent bg-accent/20 z-10 select-none active:cursor-grabbing shadow-sm"
              >
                {/* Left Resize Handle */}
                <div
                  onPointerDown={(e) => handlePointerDown("resize-left", e)}
                  className="h-full w-4 cursor-ew-resize flex items-center justify-center -ml-1 hover:bg-accent/40 rounded-l-xs bg-accent/30 transition-colors"
                  title="Drag to adjust clip start"
                >
                  <div className="h-5 w-1 rounded-full bg-accent" />
                </div>

                <div className="pointer-events-none flex items-center gap-1 px-1 select-none">
                  <span className="mono-num rounded-xs bg-bg/95 px-1.5 py-0.5 text-[10px] font-semibold text-text shadow-xs">
                    {clipSeconds(windowRange).toFixed(1)}s
                  </span>
                </div>

                {/* Right Resize Handle */}
                <div
                  onPointerDown={(e) => handlePointerDown("resize-right", e)}
                  className="h-full w-4 cursor-ew-resize flex items-center justify-center -mr-1 hover:bg-accent/40 rounded-r-xs bg-accent/30 transition-colors"
                  title="Drag to adjust clip end"
                >
                  <div className="h-5 w-1 rounded-full bg-accent" />
                </div>
              </div>
            </div>
          </div>

          {/* Project Details Section */}
          <div className="space-y-3 border-t border-line pt-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Project Details
              </span>
              <span className="mono-num text-[11px] text-muted">
                Customizable · Used in Studio
              </span>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* Project Name Input */}
              <div className="space-y-1">
                <label htmlFor="project-title-input" className="block text-xs font-medium text-text">
                  Project Name
                </label>
                <input
                  id="project-title-input"
                  type="text"
                  value={projectTitle}
                  onChange={(event) => setProjectTitle(event.target.value)}
                  placeholder="e.g. My New Song"
                  disabled={busy}
                  className="mono-num h-9 w-full rounded-card border border-line-2 bg-inset px-3 text-xs text-text placeholder:text-muted focus:border-text focus:outline-none"
                />
              </div>

              {/* Target Sound / Isolation Input */}
              <div className="space-y-1">
                <label htmlFor="target-sound-input" className="block text-xs font-medium text-text">
                  Sound to Isolate <span className="text-muted font-normal">(optional)</span>
                </label>
                <input
                  id="target-sound-input"
                  type="text"
                  value={promptInput}
                  onChange={(event) => setPromptInput(event.target.value)}
                  placeholder="e.g. piano chords, synth lead, vocals"
                  disabled={busy}
                  className="mono-num h-9 w-full rounded-card border border-line-2 bg-inset px-3 text-xs text-text placeholder:text-muted focus:border-text focus:outline-none"
                />
              </div>
            </div>

            {/* Quick Suggestion Chips for Sound */}
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-[11px] text-muted">Preset sounds:</span>
              {SUGGESTION_QUICK_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  disabled={busy}
                  onClick={() => setPromptInput(preset)}
                  className={`cursor-pointer rounded-full border px-2.5 py-0.5 text-xs transition disabled:opacity-50 ${
                    promptInput === preset
                      ? "border-control bg-surface-2 font-medium text-text shadow-xs"
                      : "border-line-2 bg-bg text-text-2 hover:border-control hover:text-text"
                  }`}
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {selectedFile !== null && !busy ? (
        <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={rightsChecked}
              onChange={(event) => setRightsChecked(event.target.checked)}
              className="h-3.5 w-3.5 rounded-icon border-control bg-bg accent-text"
            />
            <span className="text-[11px] text-muted">
              I own this media or have permission to use it.
            </span>
          </label>

          <button
            type="button"
            disabled={selectedFile === null || !rightsChecked || busy}
            onClick={() => void handleSubmit()}
            className="mono-num flex h-8 shrink-0 cursor-pointer items-center justify-center gap-2 rounded-icon bg-text px-4 text-xs font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
          >
            {promptInput.trim().length > 0 ? "Create Project & Isolate →" : "Create Studio Project →"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
