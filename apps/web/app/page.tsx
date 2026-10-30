import Link from "next/link";
import { ClipPicker } from "@/components/ClipPicker";
import { AddShell } from "@/components/StudioShell";
import { DEMO_CLIP_IDS, loadTrackMap } from "@/lib/trackmap/load";

export default async function AddPage() {
  const demos = await Promise.all(
    DEMO_CLIP_IDS.map(async (id) => ({
      id,
      trackMap: await loadTrackMap(id),
    })),
  );

  const inspector = (
    <div className="space-y-4 text-xs">
      <div>
        <span className="eyebrow mb-2 block">Demo Projects</span>
        <div className="space-y-2">
          {demos.map(({ id, trackMap }) => {
            if (trackMap === null) return null;
            return (
              <Link
                key={id}
                href={`/c/${id}/pick`}
                className="group block rounded-card border border-line-2 bg-inset p-3 transition hover:border-control hover:bg-surface-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-text group-hover:text-accent">
                    {trackMap.source.title}
                  </span>
                  <span className="mono-num rounded-icon border border-line-2 bg-bg px-1.5 py-0.5 text-[10px] uppercase text-accent">
                    Ready
                  </span>
                </div>
                <p className="mono-num mt-1 text-[11px] text-muted">
                  {Math.round(trackMap.tempo.bpm)} BPM · {trackMap.key.tonic} {trackMap.key.mode} · 30s
                </p>
                {trackMap.summary !== undefined ? (
                  <p className="mt-1 text-[11px] leading-snug text-text-2">
                    {trackMap.summary}
                  </p>
                ) : null}

                {trackMap.isolations.length > 0 ? (
                  <div className="mt-2 flex flex-wrap gap-1 border-t border-line-2 pt-1.5">
                    {trackMap.isolations.map((iso) => (
                      <span
                        key={iso.id}
                        className="mono-num rounded-icon border border-line-2 bg-bg px-1.5 py-0.5 text-[10px] text-text-2"
                      >
                        {iso.label}
                      </span>
                    ))}
                  </div>
                ) : null}

                <div className="mt-2 flex items-center justify-between text-[11px] font-medium text-text group-hover:text-accent">
                  <span>Open Studio Project</span>
                  <span className="transition-transform group-hover:translate-x-0.5">→</span>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5 border-t border-line pt-3">
        <span className="eyebrow block">Studio Workspaces</span>
        <div className="space-y-1.5 text-[11px] text-text-2">
          <div className="rounded-well border border-line-2 bg-inset px-2.5 py-1.5">
            <span className="font-semibold text-text">Isolate</span>
            <p className="text-muted leading-tight">Tap any sound or enter text prompt to separate audio.</p>
          </div>
          <div className="rounded-well border border-line-2 bg-inset px-2.5 py-1.5">
            <span className="font-semibold text-text">Analyze (X-Ray)</span>
            <p className="text-muted leading-tight">Tempo, key, chords, and piano roll note transcription.</p>
          </div>
          <div className="rounded-well border border-line-2 bg-inset px-2.5 py-1.5">
            <span className="font-semibold text-text">Practice &amp; Learn</span>
            <p className="text-muted leading-tight">Interactive keyboard with real-time AI coach feedback.</p>
          </div>
        </div>
      </div>

      <div className="space-y-1.5 border-t border-line pt-3">
        <span className="eyebrow block">Media Limits</span>
        <div className="grid grid-cols-2 gap-1.5 text-[10px]">
          <div className="rounded-icon border border-line-2 bg-inset p-1.5">
            <span className="text-muted block">Duration</span>
            <span className="mono-num text-text">≤ 30s selection</span>
          </div>
          <div className="rounded-icon border border-line-2 bg-inset p-1.5">
            <span className="text-muted block">File Size</span>
            <span className="mono-num text-text">≤ 50 MB</span>
          </div>
          <div className="rounded-icon border border-line-2 bg-inset p-1.5">
            <span className="text-muted block">Audio</span>
            <span className="mono-num text-text">MP3, WAV, FLAC</span>
          </div>
          <div className="rounded-icon border border-line-2 bg-inset p-1.5">
            <span className="text-muted block">Video</span>
            <span className="mono-num text-text">MP4, MOV, WebM</span>
          </div>
        </div>
      </div>

      <div className="border-t border-line pt-2 text-[10px] text-muted">
        <p className="leading-tight">
          Processed privately in ephemeral containers. Never used for AI training.
        </p>
      </div>
    </div>
  );

  return <AddShell center={<ClipPicker />} inspector={inspector} />;
}
