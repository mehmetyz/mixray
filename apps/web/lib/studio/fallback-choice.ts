import type { FallbackStem, Isolation } from "@/lib/trackmap/trackmap.generated";

export interface PitchConfidenceComparison {
  stem: FallbackStem;
  hasComparison: boolean;
  samConfidence: number | null;
  demucsConfidence: number | null;
  preferredMethod: "sam_audio" | "demucs";
  confidenceDelta: number;
  reason: string;
}

const UNPITCHED_STEMS = new Set(["drums"]);

export function isUnpitchedStem(stemName: string): boolean {
  return UNPITCHED_STEMS.has(stemName.toLowerCase());
}

export function compareStemPitchConfidence(
  isolation: Isolation | undefined,
  fallbackStem: FallbackStem | null,
  allIsolations?: readonly Isolation[],
): PitchConfidenceComparison | null {
  if (isolation === undefined || fallbackStem === null) {
    return null;
  }

  const stemNameLower = fallbackStem.name.toLowerCase();

  // Unpitched stems (e.g. drums) have no meaningful pitch confidence; Demucs provides
  // strictly superior separation (+9.52 dB over mix vs SAM Audio's -2.20 dB degradation).
  if (isUnpitchedStem(stemNameLower)) {
    return {
      stem: fallbackStem,
      hasComparison: true,
      samConfidence: null,
      demucsConfidence: null,
      preferredMethod: "demucs",
      confidenceDelta: 0,
      reason: "Demucs defaults for drums (+9.5 dB separation vs SAM Audio degradation)",
    };
  }

  const samConfidence =
    isolation.method !== "demucs" ? (isolation.pitch_confidence ?? null) : null;

  // Search for a matching Demucs isolation for this stem if available
  const demucsIso = allIsolations?.find(
    (iso) =>
      iso.method === "demucs" &&
      (iso.label.toLowerCase().includes(stemNameLower) ||
        iso.prompt.toLowerCase().includes(stemNameLower)),
  );

  const demucsConfidence = demucsIso?.pitch_confidence ?? null;

  // If both confidences are known, directly compare them
  if (samConfidence !== null && demucsConfidence !== null) {
    const diff = Number(Math.abs(demucsConfidence - samConfidence).toFixed(3));
    const preferredMethod = demucsConfidence > samConfidence ? "demucs" : "sam_audio";
    const samPercent = Math.round(samConfidence * 100);
    const demucsPercent = Math.round(demucsConfidence * 100);

    const reason =
      demucsConfidence > samConfidence
        ? `Demucs chosen as cleaner transcription (${demucsPercent}% vs ${samPercent}% pitch confidence)`
        : `SAM Audio chosen as higher confidence (${samPercent}% vs ${demucsPercent}% pitch confidence)`;

    return {
      stem: fallbackStem,
      hasComparison: true,
      samConfidence,
      demucsConfidence,
      preferredMethod,
      confidenceDelta: diff,
      reason,
    };
  }

  return {
    stem: fallbackStem,
    hasComparison: false,
    samConfidence,
    demucsConfidence,
    preferredMethod: "sam_audio",
    confidenceDelta: 0,
    reason: `Standard ${fallbackStem.name} stem available from Demucs fallback`,
  };
}

