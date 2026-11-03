"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { StemPlayer, type LoopRange, type StemName, type StemSource } from "@/lib/audio/player";
import { waitForNotes } from "@/lib/engine/client";
import { barRangeToSeconds, playableStemUrls } from "@/lib/studio/format";
import { rememberSound, useProject } from "@/lib/projects/storage";
import { soundsAskedFor } from "@/lib/projects/types";
import type { Isolation, TrackMap } from "@/lib/trackmap/trackmap.generated";

import type {
  CoachAction,
  HandFilter,
  MarkProblemBarAction,
  MarkProblemBarArgs,
  SetLoopAction,
  SetLoopArgs,
  SetTempoAction,
  SetTempoArgs,
  SimplifyBarAction,
  SimplifyBarArgs,
  SwitchHandAction,
  SwitchHandArgs,
} from "@/lib/coach";

export type {
  CoachAction,
  HandFilter,
  MarkProblemBarAction,
  MarkProblemBarArgs,
  SetLoopAction,
  SetLoopArgs,
  SetTempoAction,
  SetTempoArgs,
  SimplifyBarAction,
  SimplifyBarArgs,
  SwitchHandAction,
  SwitchHandArgs,
};

export type BarLoop = {
  startBar: number;
  endBar: number;
};

export type ProblemBarMark = {
  bar: number;
  reason: string;
};

export type CoachActionEntry = {
  id: string;
  summary: string;
};

export type StudioContextValue = {
  clipId: string;
  trackMap: TrackMap;
  selectedIsolation: Isolation | undefined;
  selectedIsolationId: string;
  monitor: StemName;
  playing: boolean;
  currentTime: number;
  duration: number;
  ratePercent: number;
  loopBars: BarLoop | null;
  loopRange: LoopRange | null;
  problemBar: ProblemBarMark | null;
  handFilter: HandFilter;
  simplifiedBars: number[];
  coachEntries: CoachActionEntry[];
  selectIsolation: (isolationId: string) => void;
  setMonitor: (stem: StemName) => void;
  togglePlay: () => void;
  seek: (seconds: number) => void;
  /** The player's own clock, finer than the `currentTime` state a render reads. */
  getPlaybackTime: () => number;
  /** Kept here so Track stays on when moving between Isolate and Analyze. */
  followedTrackId: string | null;
  setFollowedTrackId: (trackId: string | null) => void;
  setDucked: (ducked: boolean) => void;
  /** The sound is ready but its notes are still being written. */
  notesPending: boolean;
  setRatePercent: (percent: number) => void;
  setLoopBars: (bars: BarLoop | null) => void;
  applyCoachAction: (action: CoachAction) => void;
  resetCoachOverrides: () => void;
};

const StudioContext = createContext<StudioContextValue | null>(null);

type UrlIsoSyncProps = {
  onIsoParam: (iso: string | null) => void;
};

function UrlIsoSync({ onIsoParam }: UrlIsoSyncProps) {
  const searchParams = useSearchParams();
  const iso = searchParams.get("iso");

  useEffect(() => {
    onIsoParam(iso);
  }, [iso, onIsoParam]);

  return null;
}

type StudioProviderProps = {
  clipId: string;
  initialTrackMap: TrackMap;
  children: ReactNode;
};

function formatCoachSummary(action: CoachAction): string {
  switch (action.name) {
    case "set_loop":
      return `set_loop bars ${action.args.start_bar}–${action.args.end_bar}`;
    case "set_tempo":
      return `set_tempo ${action.args.percent}%`;
    case "switch_hand":
      return `switch_hand ${action.args.hand}`;
    case "simplify_bar":
      return `simplify_bar bar ${action.args.bar}`;
    case "mark_problem_bar":
      return `mark_problem_bar bar ${action.args.bar} · ${action.args.reason}`;
  }
}

const PRACTICE_PLAYBACK_VOLUME = 0.4;

export function StudioProvider({ clipId, initialTrackMap, children }: StudioProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const project = useProject(clipId);
  const trackMap = useMemo(
    () => soundsAskedFor(initialTrackMap, project?.soundIds),
    [initialTrackMap, project?.soundIds],
  );

  const firstIsoId = trackMap.isolations[0]?.id ?? "";
  const [requestedIsoId, setRequestedIsoId] = useState<string>(firstIsoId);
  const [monitor, setMonitorState] = useState<StemName>("sound");
  const [playing, setPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [followedTrackId, setFollowedTrackId] = useState<string | null>(null);
  const [ratePercent, setRatePercentState] = useState<number>(100);
  const [loopBars, setLoopBarsState] = useState<BarLoop | null>(null);
  const [problemBar, setProblemBar] = useState<ProblemBarMark | null>(null);
  const [handFilter, setHandFilter] = useState<HandFilter>("both");
  const [simplifiedBars, setSimplifiedBars] = useState<number[]>([]);
  const [coachEntries, setCoachEntries] = useState<CoachActionEntry[]>([]);

  const playerRef = useRef<StemPlayer | null>(null);
  const latestTimeRef = useRef<number>(0);
  const latestMonitorRef = useRef<StemName>("sound");

  // On Practice the keys carry the part, so the track sits under them instead of over them.
  const playbackVolume = pathname?.endsWith("/learn") === true ? PRACTICE_PLAYBACK_VOLUME : 1;
  const latestVolumeRef = useRef<number>(playbackVolume);
  useEffect(() => {
    latestVolumeRef.current = playbackVolume;
    playerRef.current?.setVolume(playbackVolume);
  }, [playbackVolume]);
  const latestRateRef = useRef<number>(100);
  const latestLoopRef = useRef<LoopRange | null>(null);
  const pendingPlayRef = useRef<boolean>(false);
  const resumePlayingRef = useRef<boolean>(false);

  // A listening preview on Isolate only: every later screen shows the notes of the selected sound,
  // so it has to play and export that same sound.

  const selectedIsolation = useMemo(() => {
    const exact = trackMap.isolations.find((item) => item.id === requestedIsoId);
    return exact ?? trackMap.isolations[0];
  }, [trackMap.isolations, requestedIsoId]);

  const selectedIsolationId = selectedIsolation?.id ?? "";

  const [notesGaveUpFor, setNotesGaveUpFor] = useState<string | null>(null);
  const awaitingNotes = selectedIsolation !== undefined && selectedIsolation.pitch_confidence === undefined;
  const notesPending = awaitingNotes && notesGaveUpFor !== selectedIsolationId;

  useEffect(() => {
    if (!notesPending) return;
    const controller = new AbortController();
    void waitForNotes(clipId, selectedIsolationId, controller.signal)
      .then((ready) => {
        if (controller.signal.aborted) return;
        if (ready) router.refresh();
        else setNotesGaveUpFor(selectedIsolationId);
      })
      .catch(() => {
        if (!controller.signal.aborted) setNotesGaveUpFor(selectedIsolationId);
      });
    return () => controller.abort();
  }, [notesPending, clipId, selectedIsolationId, router]);

  const effectiveSoundUrl = selectedIsolation?.sound_url ?? trackMap.source.mix_url ?? "";

  const loopRange = useMemo<LoopRange | null>(() => {
    if (loopBars === null) return null;
    return barRangeToSeconds(
      loopBars.startBar,
      loopBars.endBar,
      trackMap.downbeats,
      trackMap.duration,
    );
  }, [loopBars, trackMap.downbeats, trackMap.duration]);

  useEffect(() => {
    latestLoopRef.current = loopRange;
    playerRef.current?.setLoop(loopRange);
  }, [loopRange]);

  const handleIsoParam = useCallback(
    (iso: string | null) => {
      if (iso !== null && iso.length > 0) {
        const targetIso = initialTrackMap.isolations.find((item) => item.id === iso);
        if (targetIso !== undefined) {
          rememberSound(clipId, iso);
          setRequestedIsoId(iso);
        }
      }
    },
    [clipId, initialTrackMap.isolations],
  );

  // The player only depends on which files it plays. A refreshed TrackMap, which arrives whenever
  // notes or a recipe land, must not rebuild it and stop the music.
  const mixUrl = trackMap.source.mix_url;
  const stemKey =
    selectedIsolation === undefined
      ? `mix:${mixUrl ?? ""}`
      : `${effectiveSoundUrl}|${selectedIsolation.rest_url}|${mixUrl ?? ""}`;
  const playerInputsRef = useRef({ trackMap, selectedIsolation, effectiveSoundUrl });
  useEffect(() => {
    playerInputsRef.current = { trackMap, selectedIsolation, effectiveSoundUrl };
  }, [trackMap, selectedIsolation, effectiveSoundUrl]);

  useEffect(() => {
    const inputs = playerInputsRef.current;

    const startPlayer = (sources: StemSource[]) => {
      const resumeAt = latestTimeRef.current;
      const nextPlayer = new StemPlayer(sources, {
        onTime: (sec) => {
          latestTimeRef.current = sec;
          setCurrentTime(sec);
        },
        onEnded: () => {
          setPlaying(false);
        },
      });

      nextPlayer.setActive(latestMonitorRef.current);
      nextPlayer.setVolume(latestVolumeRef.current);
      nextPlayer.setRate(latestRateRef.current / 100);
      nextPlayer.setLoop(latestLoopRef.current);
      if (resumeAt > 0) {
        nextPlayer.seek(resumeAt);
      }

      playerRef.current = nextPlayer;
      if (resumePlayingRef.current || pendingPlayRef.current) {
        resumePlayingRef.current = false;
        pendingPlayRef.current = false;
        void nextPlayer
          .play()
          .then(() => setPlaying(true))
          .catch(() => {
            nextPlayer.pause();
            setPlaying(false);
          });
      } else {
        setPlaying(false);
      }
    };

    if (inputs.selectedIsolation === undefined) {
      // No sound separated yet: the mix still plays while the first one is being worked on.
      const mix = inputs.trackMap.source.mix_url;
      if (mix !== undefined) startPlayer([{ name: "mix", url: mix }]);
    } else {
      const stems = playableStemUrls(
        inputs.trackMap,
        inputs.selectedIsolation,
        inputs.effectiveSoundUrl,
      );
      startPlayer([
        { name: "sound", url: stems.soundUrl },
        { name: "rest", url: stems.restUrl },
        { name: "mix", url: stems.mixUrl },
      ]);
    }

    return () => {
      const activePlayer = playerRef.current;
      if (activePlayer !== null) resumePlayingRef.current = activePlayer.playing;
      playerRef.current = null;
      void activePlayer?.dispose();
    };
  }, [clipId, stemKey]);

  const selectIsolation = useCallback(
    (isolationId: string) => {
      rememberSound(clipId, isolationId);
      setRequestedIsoId(isolationId);
      if (pathname !== null && pathname.length > 0) {
        router.replace(`${pathname}?iso=${encodeURIComponent(isolationId)}`, { scroll: false });
      }
    },
    [clipId, pathname, router],
  );

  const setMonitor = useCallback((stem: StemName) => {
    latestMonitorRef.current = stem;
    setMonitorState(stem);
    playerRef.current?.setActive(stem);
  }, []);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (player === null) {
      pendingPlayRef.current = !pendingPlayRef.current;
      setPlaying(pendingPlayRef.current);
      return;
    }
    if (player.playing) {
      player.pause();
      setPlaying(false);
      return;
    }
    void player
      .play()
      .then(() => setPlaying(true))
      .catch(() => {
        player.pause();
        setPlaying(false);
      });
  }, []);

  const getPlaybackTime = useCallback(
    () => playerRef.current?.currentTime ?? latestTimeRef.current,
    [],
  );

  const setDucked = useCallback((ducked: boolean) => {
    playerRef.current?.setDucked(ducked);
  }, []);

  const seek = useCallback(
    (seconds: number) => {
      const clamped = Math.max(0, Math.min(trackMap.duration, seconds));
      latestTimeRef.current = clamped;
      setCurrentTime(clamped);
      playerRef.current?.seek(clamped);
    },
    [trackMap.duration],
  );

  const setRatePercent = useCallback((percent: number) => {
    const clamped = Math.max(40, Math.min(100, Math.round(percent)));
    latestRateRef.current = clamped;
    setRatePercentState(clamped);
    playerRef.current?.setRate(clamped / 100);
  }, []);

  const setLoopBars = useCallback((bars: BarLoop | null) => {
    setLoopBarsState(bars);
  }, []);

  const applyCoachAction = useCallback(
    (action: CoachAction) => {
      switch (action.name) {
        case "set_loop":
          setLoopBarsState({
            startBar: action.args.start_bar,
            endBar: action.args.end_bar,
          });
          break;
        case "set_tempo":
          setRatePercent(action.args.percent);
          break;
        case "switch_hand":
          setHandFilter(action.args.hand);
          break;
        case "simplify_bar":
          setSimplifiedBars((prev) =>
            prev.includes(action.args.bar) ? prev : [...prev, action.args.bar],
          );
          break;
        case "mark_problem_bar":
          setProblemBar({ bar: action.args.bar, reason: action.args.reason });
          break;
      }
      setCoachEntries((prev) => [
        ...prev.slice(-4),
        { id: `${Date.now()}-${Math.random()}`, summary: formatCoachSummary(action) },
      ]);
    },
    [setRatePercent],
  );

  const resetCoachOverrides = useCallback(() => {
    setProblemBar(null);
    setLoopBarsState(null);
    setRatePercent(100);
    setHandFilter("both");
    setSimplifiedBars([]);
    setCoachEntries([]);
  }, [setRatePercent]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (event.code === "Space" || event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else if (event.key === "1") {
        setMonitor("sound");
      } else if (event.key === "2") {
        setMonitor("rest");
      } else if (event.key === "3") {
        setMonitor("mix");
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, setMonitor]);

  const value = useMemo<StudioContextValue>(
    () => ({
      clipId,
      trackMap,
      selectedIsolation,
      selectedIsolationId,
      monitor: selectedIsolation === undefined ? "mix" : monitor,
      playing,
      currentTime,
      duration: trackMap.duration,
      ratePercent,
      loopBars,
      loopRange,
      problemBar,
      handFilter,
      simplifiedBars,
      coachEntries,
      selectIsolation,
      setMonitor,
      togglePlay,
      seek,
      getPlaybackTime,
      followedTrackId,
      setFollowedTrackId,
      setDucked,
      notesPending,
      setRatePercent,
      setLoopBars,
      applyCoachAction,
      resetCoachOverrides,
    }),
    [
      clipId,
      trackMap,
      selectedIsolation,
      selectedIsolationId,
      monitor,
      playing,
      currentTime,
      ratePercent,
      loopBars,
      loopRange,
      problemBar,
      handFilter,
      simplifiedBars,
      coachEntries,
      selectIsolation,
      setMonitor,
      togglePlay,
      seek,
      getPlaybackTime,
      followedTrackId,
      setDucked,
      notesPending,
      setRatePercent,
      setLoopBars,
      applyCoachAction,
      resetCoachOverrides,
    ],
  );

  return (
    <StudioContext.Provider value={value}>
      <Suspense fallback={null}>
        <UrlIsoSync onIsoParam={handleIsoParam} />
      </Suspense>
      {children}
    </StudioContext.Provider>
  );
}

export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (ctx === null) {
    throw new Error("useStudio must be called within a StudioProvider.");
  }
  return ctx;
}

