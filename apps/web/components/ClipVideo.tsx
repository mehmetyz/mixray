"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { followTrack, waitForTrackFrames } from "@/lib/engine/client";
import type { VideoArea } from "@/lib/studio/area";
import { useStudio } from "./StudioContext";
import { VideoMaskStage } from "./VideoMaskStage";

type ClipVideoProps = {
  /** Present on Isolate: dragging over the video draws an area to separate. */
  onSelectArea?: (area: VideoArea, frame: number) => void;
  areaBusy?: boolean;
  sizeClass: string;
};

/**
 * The clip's video with the Track switch under it, the same on Isolate and Analyze. Track follows
 * the selected sound's drawn area through the video with SAM 3.1; a sound picked by name has no area,
 * so it has nothing to follow.
 */
export function ClipVideo({ onSelectArea, areaBusy, sizeClass }: ClipVideoProps) {
  const router = useRouter();
  const { clipId, trackMap, selectedIsolationId } = useStudio();
  // Each holds the track it belongs to, so switching sounds can never show another sound's state.
  const [followedTrackId, setFollowedTrackId] = useState<string | null>(null);
  const [busyTrackId, setBusyTrackId] = useState<string | null>(null);
  const [trackingError, setTrackingError] = useState<{ trackId: string; message: string } | null>(null);

  const video = trackMap.video;
  if (video === undefined) return null;
  const selectedTrack = video.tracks.find((track) => track.isolation_id === selectedIsolationId);
  const trackingOn = selectedTrack !== undefined && followedTrackId === selectedTrack.id;
  const trackingBusy = selectedTrack !== undefined && busyTrackId === selectedTrack.id;
  const errorMessage =
    selectedTrack !== undefined && trackingError?.trackId === selectedTrack.id
      ? trackingError.message
      : null;

  const toggleTracking = async () => {
    if (selectedTrack === undefined || trackingBusy) return;
    if (trackingOn) {
      setFollowedTrackId(null);
      return;
    }
    if (selectedTrack.visible.length > 0) {
      setFollowedTrackId(selectedTrack.id);
      return;
    }
    setTrackingError(null);
    setBusyTrackId(selectedTrack.id);
    try {
      await followTrack(clipId, selectedTrack.id);
      await waitForTrackFrames(selectedTrack.masks_url);
      router.refresh();
      setFollowedTrackId(selectedTrack.id);
    } catch (error: unknown) {
      setTrackingError({
        trackId: selectedTrack.id,
        message: error instanceof Error ? error.message : "Could not track this area.",
      });
    } finally {
      setBusyTrackId(null);
    }
  };

  return (
    <>
      <VideoMaskStage
        video={video}
        onSelectArea={onSelectArea}
        areaBusy={areaBusy}
        followedTrackId={trackingOn ? selectedTrack.id : undefined}
        sizeClass={sizeClass}
      />
      {selectedTrack !== undefined ? (
        <div className="flex items-center justify-between gap-3 border-b border-line bg-surface px-4 py-2 text-sm">
          <span role={errorMessage !== null ? "alert" : undefined} className="min-w-0 truncate text-muted">
            {errorMessage ??
              (trackingBusy
                ? `Following ${selectedTrack.label} through the video…`
                : `Follow ${selectedTrack.label} in the video`)}
          </span>
          <button
            type="button"
            aria-pressed={trackingOn}
            disabled={trackingBusy}
            onClick={() => void toggleTracking()}
            className={`shrink-0 cursor-pointer rounded-full border px-3 py-1 text-xs font-medium disabled:cursor-wait disabled:opacity-60 ${
              trackingOn ? "border-accent text-accent" : "border-line-2 text-text-2 hover:text-text"
            }`}
          >
            {trackingBusy ? "Tracking…" : trackingOn ? "Track on" : "Track off"}
          </button>
        </div>
      ) : null}
    </>
  );
}
