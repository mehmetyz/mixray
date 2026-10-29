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

export function compareStemPitchConfidence(
  isolation: Isolation | undefined,
  fallbackStem: FallbackStem | null,
  allIsolations?: readonly Isolation[],
): PitchConfidenceComparison | null {
  if (isolation === undefined || fallbackStem === null) {
    return null;
  }

  const samConfidence =
    isolation.method !== "demucs" ? (isolation.pitch_confidence ?? null) : null;

  // Search for a matching Demucs isolation for this stem if available
  const stemNameLower = fallbackStem.name.toLowerCase();
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

