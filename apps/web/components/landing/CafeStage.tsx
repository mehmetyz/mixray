"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { StemPlayer, type StemName } from "@/lib/audio/player";
import { TrackedCorners } from "@/components/TrackedCorners";
import { CAFE_EXCERPT } from "@/lib/landing/cafe-excerpt";

export type StageStep = 0 | 1 | 2 | 3;

type CafeStageProps = {
  step: StageStep;
  onReveal: () => void;
};

type WaveProps = {
  peaks: readonly number[];
  className: string;
};

const SOURCES = [
  { name: "mix" as const, url: "/landing/mix.mp3" },
  { name: "sound" as const, url: "/landing/piano.mp3" },
];
const VIDEO_DRIFT_SECONDS = 0.15;
const SEGMENT =
  "h-8 cursor-pointer rounded-icon px-3 text-xs font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text";
const { area, duration, label, mixPeaks, notes, pianoPeaks } = CAFE_EXCERPT;

function Wave({ peaks, className }: WaveProps) {
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${peaks.length} 100`} preserveAspectRatio="none" className={`h-full w-full ${className}`}>
      {peaks.map((peak, index) => {
        const height = Math.max(2, peak * 94);
        return <rect key={index} x={index + 0.15} y={50 - height / 2} width={0.7} height={height} fill="currentColor" />;
      })}
    </svg>
  );
}

function NoteRoll({ time }: { time: number }) {
  const pitches = useMemo(() => notes.map((note) => note[2]), []);
  const low = Math.min(...pitches);
  const span = Math.max(1, Math.max(...pitches) - low);
  return (
    <svg aria-hidden="true" viewBox={`0 0 ${duration} 100`} preserveAspectRatio="none" className="h-full w-full">
      {notes.map(([start, end, pitch], index) => {
        const sounding = time >= start && time < end;
        return (
          <rect
            key={index}
            x={start}
            y={88 - ((pitch - low) / span) * 76}
            width={Math.max(0.05, end - start)}
            height={9}
            rx={0.02}
            className={sounding ? "fill-accent" : "fill-text-2"}
          />
        );
      })}
    </svg>
  );
}

/** The café demo as Mixray really produced it: the area drawn, the piano apart from the mix, its notes. */
export function CafeStage({ step, onReveal }: CafeStageProps) {
  const playerRef = useRef<StemPlayer | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState<boolean>(false);
  const [heard, setHeard] = useState<StemName>("mix");
  const [time, setTime] = useState<number>(0);
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => () => void playerRef.current?.dispose(), []);

  const syncVideo = (seconds: number) => {
    const video = videoRef.current;
    if (video !== null && Math.abs(video.currentTime - seconds) > VIDEO_DRIFT_SECONDS) video.currentTime = seconds;
  };

  const player = (): StemPlayer => {
    playerRef.current ??= new StemPlayer([...SOURCES], {
      onTime: (seconds) => {
        setTime(seconds);
        syncVideo(seconds);
      },
      onEnded: () => {
        setPlaying(false);
        videoRef.current?.pause();
        playerRef.current?.seek(0);
      },
    });
    return playerRef.current;
  };

  const start = async () => {
    setFailed(false);
    onReveal();
    try {
      await player().play();
      setPlaying(true);
      void videoRef.current?.play().catch(() => undefined);
    } catch {
      setPlaying(false);
      setFailed(true);
    }
  };

  const toggle = () => {
    if (playing) {
      player().pause();
      videoRef.current?.pause();
      setPlaying(false);
      return;
    }
    void start();
  };

  const hear = (name: StemName) => {
    setHeard(name);
    player().setActive(name);
    if (!playing) void start();
  };

  const position = `${(time / duration) * 100}%`;
  const pianoHeard = heard === "sound";

  return (
    <figure className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="relative aspect-video bg-inset">
        <video
          ref={videoRef}
          src="/demos/cafe-piano/video.mp4"
          poster="/demos/cafe-piano/poster.jpg"
          muted
          playsInline
          preload="metadata"
          aria-label="A pianist in a café while steam hisses from an espresso machine"
          className="h-full w-full object-cover"
        />
        <div
          aria-hidden="true"
          style={{
            left: `${area.left * 100}%`,
            top: `${area.top * 100}%`,
            width: `${(area.right - area.left) * 100}%`,
            height: `${(area.bottom - area.top) * 100}%`,
          }}
          className={`absolute shadow-[0_0_0_100vmax_rgb(0_0_0/0.3)] transition-opacity duration-700 ease-out motion-reduce:transition-none ${
            step >= 1 ? "opacity-100" : "opacity-0"
          }`}
        >
          <TrackedCorners />
          <span className="absolute top-1.5 left-2 rounded-full bg-bg/80 px-2 py-0.5 text-xs text-text">
            {label}
          </span>
        </div>
      </div>

      <div className="relative">
        <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] border-t border-line">
          <div className="flex items-center px-3 text-xs font-medium text-text-2">Full mix</div>
          <div className="h-16 bg-inset py-1.5">
            <Wave peaks={mixPeaks} className={pianoHeard ? "text-inactive" : "text-rest"} />
          </div>
        </div>
        <div
          className={`grid transition-[grid-template-rows] duration-700 ease-out motion-reduce:transition-none ${
            step >= 2 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] border-t border-line">
              <div className="flex items-center gap-1.5 px-3 text-xs font-medium text-text">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
                Piano
              </div>
              <div className="h-16 bg-inset py-1.5">
                <Wave peaks={pianoPeaks} className={pianoHeard || !playing ? "text-accent" : "text-inactive"} />
              </div>
            </div>
          </div>
        </div>
        <div
          className={`grid transition-[grid-template-rows] duration-700 ease-out motion-reduce:transition-none ${
            step >= 3 ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
          }`}
        >
          <div className="overflow-hidden">
            <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] border-t border-line">
              <div className="flex items-center px-3 text-xs font-medium text-text">Notes</div>
              <div
                className={`h-20 bg-inset py-1.5 transition-[clip-path] delay-200 duration-1000 ease-out motion-reduce:transition-none ${
                  step >= 3 ? "[clip-path:inset(0)]" : "[clip-path:inset(0_100%_0_0)]"
                }`}
              >
                <NoteRoll time={playing ? time : -1} />
              </div>
            </div>
          </div>
        </div>
        {playing ? (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-[5.5rem] right-0">
            <span style={{ left: position }} className="absolute inset-y-0 w-px bg-text" />
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line p-3">
        <button
          type="button"
          onClick={toggle}
          className="h-8 min-w-16 cursor-pointer rounded-icon bg-text px-3 text-xs font-semibold text-bg transition hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-text"
        >
          {playing ? "Pause" : "Play"}
        </button>
        <div role="group" aria-label="What you hear" className="flex gap-1 rounded-card border border-line-2 p-0.5">
          <button
            type="button"
            aria-pressed={!pianoHeard}
            onClick={() => hear("mix")}
            className={`${SEGMENT} ${pianoHeard ? "text-text-2 hover:text-text" : "bg-surface-2 text-text"}`}
          >
            Full mix
          </button>
          <button
            type="button"
            aria-pressed={pianoHeard}
            onClick={() => hear("sound")}
            className={`${SEGMENT} ${pianoHeard ? "bg-surface-2 text-text" : "text-text-2 hover:text-text"}`}
          >
            Piano alone
          </button>
        </div>
        {failed ? <span role="alert" className="text-xs text-text">This browser could not play the audio.</span> : null}
      </div>
      <figcaption className="border-t border-line px-3 py-2 text-xs leading-relaxed text-text-2">
        Real output for an AI-generated demo video: Muse Spark named the area, SAM Audio separated the piano, Basic Pitch
        read its notes. Mixray takes a few minutes on a new clip.
      </figcaption>
    </figure>
  );
}
