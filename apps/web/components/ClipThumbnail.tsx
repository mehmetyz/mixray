"use client";

import { useEffect, useState } from "react";
import { engineFileUrl } from "@/lib/engine/client";
import type { ProjectKind } from "@/lib/projects/types";

type ClipThumbnailProps = {
  clipId: string;
  kind: ProjectKind;
};

const FRAME_SECONDS = 1;

/** A still from the engine's copy of the video, or a plain tile for a song. */
export function ClipThumbnail({ clipId, kind }: ClipThumbnailProps) {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);

  useEffect(() => {
    if (kind !== "video") return;
    let cancelled = false;
    void engineFileUrl(`clips/${clipId}/video.mp4`)
      .then((url) => {
        if (!cancelled) setVideoUrl(url);
      })
      .catch(() => {
        // Without a session the tile simply stays plain.
      });
    return () => {
      cancelled = true;
    };
  }, [clipId, kind]);

  return (
    <div className="relative aspect-video w-28 shrink-0 overflow-hidden rounded-well border border-line bg-inset">
      {videoUrl !== null ? (
        <video
          src={`${videoUrl}#t=${FRAME_SECONDS}`}
          preload="metadata"
          muted
          playsInline
          aria-hidden="true"
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-[11px] text-muted">
          {kind === "video" ? "Video" : "Audio"}
        </span>
      )}
    </div>
  );
}
