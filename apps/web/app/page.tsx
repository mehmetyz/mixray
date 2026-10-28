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
    <>
      <div>
        <span className="eyebrow mb-2 block">Or try a precomputed demo</span>
        <div className="space-y-2">
          {demos.map(({ id, trackMap }) => {
            if (trackMap === null) return null;
            return (
              <Link
                key={id}
                href={`/c/${id}/pick`}
                className="block rounded-card border border-line-2 bg-inset p-3 transition hover:border-control"
              >
                <div className="flex items-center justify-between gap-2 text-xs font-medium text-text">
                  <span>{trackMap.source.title}</span>
                  <span className="mono-num text-[10px] uppercase text-accent">
                    {trackMap.source.kind}
                  </span>
                </div>
                <p className="mono-num mt-1 text-xs text-muted">
                  {Math.round(trackMap.tempo.bpm)} BPM · {trackMap.key.tonic} {trackMap.key.mode} ·{" "}
                  {trackMap.isolations.length} stems ready
                </p>
                {trackMap.summary !== undefined ? (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-text-2">
                    {trackMap.summary}
                  </p>
                ) : null}
              </Link>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-muted">
          Demos are the builder&apos;s own music and run at zero GPU cost.
        </p>
      </div>

      <div className="space-y-2 border-t border-line pt-4">
        <span className="eyebrow block">How it works</span>
        <ol className="space-y-2 text-xs text-text-2">
          <li>
            <span className="mono-num mr-2 text-muted">01</span>Drop your clip (≤ 30 seconds).
          </li>
          <li>
            <span className="mono-num mr-2 text-muted">02</span>Tap a player (SAM 3.1) or type a
            prompt (SAM Audio).
          </li>
          <li>
            <span className="mono-num mr-2 text-muted">03</span>Inspect key, chords, notes &amp;
            synth recipe.
          </li>
          <li>
            <span className="mono-num mr-2 text-muted">04</span>Practice on MIDI/QWERTY with the
            Muse Spark coach.
          </li>
          <li>
            <span className="mono-num mr-2 text-muted">05</span>Export WAV stems, MIDI &amp; synth
            recipe.
          </li>
        </ol>
      </div>
    </>
  );

  return <AddShell center={<ClipPicker />} inspector={inspector} />;
}
