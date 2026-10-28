import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { loadTrackMap } from "@/lib/trackmap/load";
import { StudioProvider } from "./StudioContext";
import { StudioShell } from "./StudioShell";

export type ClipRouteParams = {
  id: string;
};

export type ClipLayoutProps = {
  params: Promise<ClipRouteParams>;
  children: ReactNode;
};

/** Server boundary for `/c/[id]/*`: loads TrackMap once and mounts the persistent Studio DAW shell. */
export async function ClipScreen({ params, children }: ClipLayoutProps) {
  const { id } = await params;
  const trackMap = await loadTrackMap(id);
  if (trackMap === null) notFound();

  return (
    <StudioProvider clipId={id} initialTrackMap={trackMap}>
      <StudioShell>{children}</StudioShell>
    </StudioProvider>
  );
}
