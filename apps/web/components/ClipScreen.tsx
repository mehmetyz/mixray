import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { ClipStepId } from "@/lib/steps";
import { loadTrackMap } from "@/lib/trackmap/load";
import { AppHeader } from "./AppHeader";
import { ScreenHeading } from "./ScreenHeading";

export type ClipRouteParams = {
  id: string;
};

export type ClipPageProps = {
  params: Promise<ClipRouteParams>;
};

type ClipScreenProps = {
  clipId: string;
  step: ClipStepId;
  title: string;
  children?: ReactNode;
};

/** Shell shared by every clip step: loads the clip's trackmap, renders header and heading. */
export async function ClipScreen({ clipId, step, title, children }: ClipScreenProps) {
  const trackMap = await loadTrackMap(clipId);
  if (trackMap === null) notFound();

  const { source, tempo, key } = trackMap;

  return (
    <>
      <AppHeader nav={{ current: step, clipId, soundPicked: trackMap.isolations.length > 0 }} />
      <main className="page-container flex flex-col gap-6 py-10">
        <ScreenHeading step={step} title={title}>
          <p className="font-mono text-sm text-text-2">
            {source.title} · {Math.round(tempo.bpm)} BPM · {key.tonic} {key.mode}
          </p>
        </ScreenHeading>
        {children}
      </main>
    </>
  );
}
