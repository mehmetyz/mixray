import type { LoopRange } from "@/lib/audio/player";
import type {
  FallbackStem,
  Isolation,
  IsolationMethod,
  Note,
  PitchRange,
  Recipe,
  StemName as TrackStemName,
  TimeSignature,
} from "@/lib/trackmap/trackmap.generated";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export type RecipeRow = {
  label: string;
  value: string;
};

export type AmpEnvelopeView = {
  attackMs: number;
  decayMs: number;
  sustain: number;
  releaseMs: number;
};

export type ParsedRecipe = {
  oscillatorRows: RecipeRow[];
  filterRows: RecipeRow[];
  fxRows: RecipeRow[];
  playRows: RecipeRow[];
  envelope: AmpEnvelopeView;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asLabelString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function midiToNoteName(midi: number): string {
  const clamped = Math.max(0, Math.min(127, Math.round(midi)));
  const octave = Math.floor(clamped / 12) - 1;
  const name = NOTE_NAMES[clamped % 12] ?? "C";
  return `${name}${octave}`;
}

export function formatPitchRange(range: PitchRange | undefined, notes: Note[]): string {
  if (range !== undefined) {
    return `${midiToNoteName(range.low)}–${midiToNoteName(range.high)}`;
  }
  const first = notes[0];
  if (first === undefined) return "—";
  let low = first.pitch;
  let high = first.pitch;
  for (const note of notes) {
    if (note.pitch < low) low = note.pitch;
    if (note.pitch > high) high = note.pitch;
  }
  return `${midiToNoteName(low)}–${midiToNoteName(high)}`;
}

export function firstSoundingBar(notes: Note[], downbeats: number[]): string {
  const first = notes[0];
  if (first === undefined) return "—";
  let earliest = first.start;
  let explicitBar = first.bar;
  for (const note of notes) {
    if (note.start < earliest) {
      earliest = note.start;
      explicitBar = note.bar;
    }
  }
  if (explicitBar !== undefined) return `Bar ${explicitBar + 1}`;
  let barIndex = 0;
  for (let index = 0; index < downbeats.length; index += 1) {
    const beat = downbeats[index];
    if (beat !== undefined && beat <= earliest + 0.05) barIndex = index;
  }
  return `Bar ${barIndex + 1}`;
}

export function formatClockSeconds(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole + 1e-6) * 10);
  return `${String(mins).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${Math.min(9, tenths)}`;
}

export function formatBarBeat(
  seconds: number,
  downbeats: number[],
  timeSignature: TimeSignature,
  duration: number,
): string {
  const beatsPerBar = Math.max(1, timeSignature[0] || 4);
  if (downbeats.length === 0) {
    return "01.1";
  }
  let barIdx = 0;
  for (let index = 0; index < downbeats.length; index += 1) {
    const start = downbeats[index];
    if (start !== undefined && seconds >= start - 0.01) {
      barIdx = index;
    }
  }
  const barStart = downbeats[barIdx] ?? 0;
  const nextStart = downbeats[barIdx + 1] ?? Math.max(duration, barStart + 1.875);
  const barSpan = Math.max(0.1, nextStart - barStart);
  const rel = Math.max(0, Math.min(0.999, (seconds - barStart) / barSpan));
  const beat = Math.floor(rel * beatsPerBar) + 1;
  return `${String(barIdx + 1).padStart(2, "0")}.${beat}`;
}

export function barRangeToSeconds(
  startBarOneBased: number,
  endBarOneBased: number,
  downbeats: number[],
  duration: number,
): LoopRange {
  const barCount = Math.max(1, downbeats.length);
  const startIdx = Math.max(0, Math.min(barCount - 1, startBarOneBased - 1));
  const endIdx = Math.max(startIdx + 1, Math.min(barCount, endBarOneBased));
  const startSeconds = downbeats[startIdx] ?? 0;
  const endSeconds = endIdx < downbeats.length ? (downbeats[endIdx] ?? duration) : duration;
  return {
    startSeconds,
    endSeconds: Math.max(startSeconds + 0.5, endSeconds),
  };
}

export function methodBadgeLabel(method: IsolationMethod, useDemucsCleaner: boolean): string {
  if (useDemucsCleaner || method === "demucs") return "DEMUCS STEM";
  if (method === "sam_audio_visual") return "SAM AUDIO · VISUAL (SAM 3.1)";
  return "SAM AUDIO · TEXT PROMPT";
}

function inferStemKind(text: string): TrackStemName | null {
  const lower = text.toLowerCase();
  if (lower.includes("piano") || lower.includes("key")) return "piano";
  if (lower.includes("bass") || lower.includes("sub")) return "bass";
  if (lower.includes("vocal") || lower.includes("voice") || lower.includes("sing")) return "vocals";
  if (lower.includes("drum") || lower.includes("kick") || lower.includes("hat")) return "drums";
  if (lower.includes("guitar")) return "guitar";
  if (
    lower.includes("lead") ||
    lower.includes("synth") ||
    lower.includes("saw") ||
    lower.includes("pluck") ||
    lower.includes("violin") ||
    lower.includes("cello")
  ) {
    return "other";
  }
  return null;
}

export function matchFallbackStem(
  isolation: Isolation | undefined,
  fallbackStems: FallbackStem[] | undefined,
): FallbackStem | null {
  if (isolation === undefined || fallbackStems === undefined || fallbackStems.length === 0) {
    return null;
  }
  if (isolation.method === "demucs") return null;
  const kind = inferStemKind(`${isolation.label} ${isolation.prompt}`);
  if (kind === null) return null;
  const found = fallbackStems.find((stem) => stem.name === kind && stem.level >= 0.08);
  return found ?? null;
}

export function deriveMixPeaks(soundPeaks: number[], restPeaks: number[] | undefined): number[] {
  const count = Math.max(soundPeaks.length, restPeaks?.length ?? 0);
  if (count === 0) return [0.35, 0.5, 0.42, 0.58, 0.48, 0.62, 0.54, 0.45];
  const combined: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const s = soundPeaks[index] ?? 0.2;
    const r = restPeaks?.[index] ?? 0.38;
    combined.push(Math.min(0.96, Math.sqrt(s * s + r * r)));
  }
  return combined;
}

export function parseRecipeSummary(recipe: Recipe | undefined): ParsedRecipe {
  const defaultEnvelope: AmpEnvelopeView = {
    attackMs: 5,
    decayMs: 320,
    sustain: 0.75,
    releaseMs: 280,
  };

  if (recipe === undefined) {
    return {
      oscillatorRows: [
        { label: "Wave", value: "Sawtooth" },
        { label: "Voices", value: "5 unison" },
      ],
      filterRows: [
        { label: "Type", value: "Lowpass 24 dB" },
        { label: "Cutoff", value: "5.8 kHz" },
      ],
      fxRows: [{ label: "Space", value: "Hall reverb · 20%" }],
      playRows: [{ label: "Voicing", value: "Polyphonic" }],
      envelope: defaultEnvelope,
    };
  }

  const oscillatorRows: RecipeRow[] = [];
  const rawOscs = recipe.oscillators;
  if (Array.isArray(rawOscs)) {
    const firstOsc: unknown = rawOscs[0];
    if (isRecord(firstOsc)) {
      oscillatorRows.push({ label: "Wave", value: asLabelString(firstOsc.wave, "saw") });
      const voices = asFiniteNumber(firstOsc.voices, 1);
      const detune = asFiniteNumber(firstOsc.detune_cents, 0);
      oscillatorRows.push({ label: "Unison", value: `${voices}v · ${detune} ct` });
    }
  }
  if (oscillatorRows.length === 0) {
    oscillatorRows.push({ label: "Wave", value: "Subtractive" });
  }

  const filterRows: RecipeRow[] = [];
  if (isRecord(recipe.filter)) {
    filterRows.push({ label: "Type", value: asLabelString(recipe.filter.type, "lowpass") });
    const cutoff = asFiniteNumber(recipe.filter.cutoff_hz, 4000);
    filterRows.push({ label: "Cutoff", value: `${Math.round(cutoff)} Hz` });
  } else {
    filterRows.push({ label: "Type", value: "Open" });
  }

  const fxRows: RecipeRow[] = [];
  if (Array.isArray(recipe.fx)) {
    for (const item of recipe.fx.slice(0, 3)) {
      if (isRecord(item)) {
        const fxType = asLabelString(item.type, "fx");
        const detail =
          typeof item.decay_s === "number"
            ? `${item.decay_s}s`
            : typeof item.mix === "number"
              ? `${Math.round(item.mix * 100)}%`
              : typeof item.depth === "number"
                ? `${Math.round(item.depth * 100)}%`
                : "on";
        fxRows.push({ label: fxType, value: detail });
      }
    }
  }
  if (fxRows.length === 0) {
    fxRows.push({ label: "FX", value: "Dry" });
  }

  const glide = recipe.glide === true ? "Portamento on" : "Legato off";
  const playRows: RecipeRow[] = [{ label: "Glide", value: glide }];

  let envelope = defaultEnvelope;
  if (isRecord(recipe.amp_env)) {
    envelope = {
      attackMs: asFiniteNumber(recipe.amp_env.attack_ms, 5),
      decayMs: asFiniteNumber(recipe.amp_env.decay_ms, 320),
      sustain: Math.max(0, Math.min(1, asFiniteNumber(recipe.amp_env.sustain, 0.75))),
      releaseMs: asFiniteNumber(recipe.amp_env.release_ms, 280),
    };
  }

  return {
    oscillatorRows,
    filterRows,
    fxRows,
    playRows,
    envelope,
  };
}

