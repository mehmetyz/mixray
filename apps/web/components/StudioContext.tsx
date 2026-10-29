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
import { StemPlayer, type LoopRange, type StemName } from "@/lib/audio/player";
import { resolvePlayableStems } from "@/lib/studio/demo-audio";
import {
  compareStemPitchConfidence,
  type PitchConfidenceComparison,
} from "@/lib/studio/fallback-choice";
import { barRangeToSeconds, matchFallbackStem } from "@/lib/studio/format";
import type { FallbackStem, Isolation, TrackMap } from "@/lib/trackmap/trackmap.generated";

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
  fallbackAlternative: FallbackStem | null;
  fallbackComparison: PitchConfidenceComparison | null;
  useDemucsCleaner: boolean;
  isSynthesizedPreview: boolean;
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
  setRatePercent: (percent: number) => void;
  setLoopBars: (bars: BarLoop | null) => void;
  setUseDemucsCleaner: (enabled: boolean) => void;
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

export function StudioProvider({ clipId, initialTrackMap, children }: StudioProviderProps) {
  const router = useRouter();
  const pathname = usePathname();
  const trackMap = initialTrackMap;

  const firstIsoId = trackMap.isolations[0]?.id ?? "";
  const [requestedIsoId, setRequestedIsoId] = useState<string>(firstIsoId);
  const [monitor, setMonitorState] = useState<StemName>("sound");
  const [playing, setPlaying] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [ratePercent, setRatePercentState] = useState<number>(100);
  const [loopBars, setLoopBarsState] = useState<BarLoop | null>(null);
  const [problemBar, setProblemBar] = useState<ProblemBarMark | null>(null);
  const [handFilter, setHandFilter] = useState<HandFilter>("both");
  const [simplifiedBars, setSimplifiedBars] = useState<number[]>([]);
  const [useDemucsCleaner, setUseDemucsCleaner] = useState<boolean>(false);
  const [isSynthesizedPreview, setIsSynthesizedPreview] = useState<boolean>(false);
  const [coachEntries, setCoachEntries] = useState<CoachActionEntry[]>([]);

  const playerRef = useRef<StemPlayer | null>(null);
  const latestTimeRef = useRef<number>(0);
  const latestMonitorRef = useRef<StemName>("sound");
  const latestRateRef = useRef<number>(100);
  const latestLoopRef = useRef<LoopRange | null>(null);

  const selectedIsolation = useMemo(() => {
    const exact = trackMap.isolations.find((item) => item.id === requestedIsoId);
    return exact ?? trackMap.isolations[0];
  }, [trackMap.isolations, requestedIsoId]);

  const selectedIsolationId = selectedIsolation?.id ?? "";

  const fallbackAlternative = useMemo(
    () => matchFallbackStem(selectedIsolation, trackMap.fallback_stems),
    [selectedIsolation, trackMap.fallback_stems],
  );

  const fallbackComparison = useMemo(
    () => compareStemPitchConfidence(selectedIsolation, fallbackAlternative, trackMap.isolations),
    [selectedIsolation, fallbackAlternative, trackMap.isolations],
  );

  const effectiveSoundUrl = useMemo(() => {
    if (useDemucsCleaner && fallbackAlternative !== null) {
      return fallbackAlternative.url;
    }
    return selectedIsolation?.sound_url ?? trackMap.source.mix_url ?? "";
  }, [useDemucsCleaner, fallbackAlternative, selectedIsolation, trackMap.source.mix_url]);

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
        const exists = trackMap.isolations.some((item) => item.id === iso);
        if (exists) setRequestedIsoId(iso);
      }
    },
    [trackMap.isolations],
  );

  useEffect(() => {
    if (selectedIsolation === undefined) return;

    let cancelled = false;
    let revokeBlobs: () => void = () => {};

    void resolvePlayableStems(trackMap, selectedIsolation, effectiveSoundUrl).then((resolved) => {
      if (cancelled) {
        resolved.revoke();
        return;
      }
      revokeBlobs = resolved.revoke;
      setIsSynthesizedPreview(resolved.isSynthesizedPreview);

      const wasPlaying = playerRef.current?.playing === true;
      const resumeAt = latestTimeRef.current;
      void playerRef.current?.dispose();

      const nextPlayer = new StemPlayer(
        [
          { name: "sound", url: resolved.soundUrl },
          { name: "rest", url: resolved.restUrl },
          { name: "mix", url: resolved.mixUrl },
        ],
        {
          onTime: (sec) => {
            latestTimeRef.current = sec;
            setCurrentTime(sec);
          },
          onEnded: () => {
            setPlaying(false);
          },
        },
      );

      nextPlayer.setActive(latestMonitorRef.current);
      nextPlayer.setRate(latestRateRef.current / 100);
      nextPlayer.setLoop(latestLoopRef.current);
      if (resumeAt > 0) {
        nextPlayer.seek(resumeAt);
      }

      playerRef.current = nextPlayer;
      if (wasPlaying) {
        void nextPlayer
          .play()
          .then(() => setPlaying(true))
          .catch(() => setPlaying(false));
      } else {
        setPlaying(false);
      }
    });

    return () => {
      cancelled = true;
      const activePlayer = playerRef.current;
      playerRef.current = null;
      void activePlayer?.dispose();
      revokeBlobs();
    };
  }, [clipId, trackMap, selectedIsolation, effectiveSoundUrl]);

  const selectIsolation = useCallback(
    (isolationId: string) => {
      setRequestedIsoId(isolationId);
      const targetIso = trackMap.isolations.find((item) => item.id === isolationId);
      const targetFallback = matchFallbackStem(targetIso, trackMap.fallback_stems);
      const comp = compareStemPitchConfidence(targetIso, targetFallback, trackMap.isolations);
      setUseDemucsCleaner(comp?.preferredMethod === "demucs");
      if (pathname !== null && pathname.length > 0) {
        router.replace(`${pathname}?iso=${encodeURIComponent(isolationId)}`, { scroll: false });
      }
    },
    [pathname, router, trackMap.isolations, trackMap.fallback_stems],
  );

  const setMonitor = useCallback((stem: StemName) => {
    latestMonitorRef.current = stem;
    setMonitorState(stem);
    playerRef.current?.setActive(stem);
  }, []);

  const togglePlay = useCallback(() => {
    const player = playerRef.current;
    if (player === null) return;
    if (player.playing) {
      player.pause();
      setPlaying(false);
      return;
    }
    void player
      .play()
      .then(() => setPlaying(true))
      .catch(() => setPlaying(false));
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
      if (event.code === "Space") {
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
      fallbackAlternative,
      fallbackComparison,
      useDemucsCleaner,
      isSynthesizedPreview,
      monitor,
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
      setRatePercent,
      setLoopBars,
      setUseDemucsCleaner,
      applyCoachAction,
      resetCoachOverrides,
    }),
    [
      clipId,
      trackMap,
      selectedIsolation,
      selectedIsolationId,
      fallbackAlternative,
      fallbackComparison,
      useDemucsCleaner,
      isSynthesizedPreview,
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

