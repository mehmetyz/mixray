/* Generated from schema/trackmap.schema.json by 'pnpm gen:types'. Do not edit. */

export type SourceKind = "audio" | "video";
/**
 * @minItems 2
 * @maxItems 2
 */
export type TimeSignature = [number, number];
export type Tonic = "C" | "C#" | "D" | "D#" | "E" | "F" | "F#" | "G" | "G#" | "A" | "A#" | "B";
export type KeyMode = "major" | "minor";
export type SectionLabel =
  "intro" | "verse" | "build" | "drop" | "breakdown" | "chorus" | "bridge" | "outro" | "section";
export type IsolationMethod = "sam_audio_text" | "sam_audio_visual" | "demucs";
export type Hand = "right" | "left";
export type StemName = "vocals" | "drums" | "bass" | "guitar" | "piano" | "other";
/**
 * @minItems 2
 * @maxItems 2
 */
export type TimeRange = [number, number];

/**
 * Engine output for one clip (≤ 30 s). The only contract between engine/ and apps/web/. Times are seconds from the start of the clip. Each sound the user picks is one entry in `isolations`.
 */
export interface TrackMap {
  version: 2;
  /**
   * SHA-256 of the decoded clip (cache key).
   */
  id: string;
  source: Source;
  duration: number;
  tempo: Tempo;
  beats: number[];
  /**
   * Bar starts; bar index = position in this array.
   */
  downbeats: number[];
  key: Key;
  chords: Chord[];
  sections: Section[];
  energy: Energy;
  /**
   * One-line Muse summary of the clip.
   */
  summary?: string;
  /**
   * Sounds Muse Spark hears in the clip, offered as chips.
   */
  suggestions: Suggestion[];
  isolations: Isolation[];
  /**
   * Demucs stems, computed once per clip; used when a prompt maps to a standard instrument.
   */
  fallback_stems?: FallbackStem[];
  video?: Video;
}
export interface Source {
  kind: SourceKind;
  title: string;
  artist?: string;
  /**
   * e.g. 'owned', 'CC BY 4.0'.
   */
  license?: string;
  /**
   * Offset of the clip in the original file.
   */
  clip_start: number;
  clip_end: number;
  /**
   * Full-mix audio of the clip for playback.
   */
  mix_url?: string;
}
export interface Tempo {
  bpm: number;
  time_signature: TimeSignature;
  confidence: number;
}
export interface Key {
  tonic: Tonic;
  mode: KeyMode;
  confidence: number;
}
export interface Chord {
  bar: number;
  start: number;
  end: number;
  /**
   * e.g. 'Am', 'F', or 'N' for no chord.
   */
  label: string;
  root_midi?: number;
}
export interface Section {
  start: number;
  end: number;
  label: SectionLabel;
}
export interface Energy {
  hop: number;
  values: number[];
}
export interface Suggestion {
  /**
   * Short UI label, e.g. 'Supersaw lead'.
   */
  label: string;
  /**
   * Text prompt sent to SAM Audio.
   */
  prompt: string;
}
export interface Isolation {
  /**
   * SHA-256 of clip id + prompt.
   */
  id: string;
  label: string;
  prompt: string;
  method: IsolationMethod;
  sound_url: string;
  sound_wav_url?: string;
  rest_url: string;
  peaks: number[];
  rest_peaks?: number[];
  /**
   * Mean transcription confidence; drives the Demucs fallback choice.
   */
  pitch_confidence?: number;
  range?: PitchRange;
  /**
   * Transcribed notes, snapped to the beat grid.
   */
  notes: Note[];
  arrangements: Arrangements;
  /**
   * One-line Muse description of this sound.
   */
  summary?: string;
  recipe?: Recipe;
}
export interface PitchRange {
  low: number;
  high: number;
}
export interface Note {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  bar?: number;
  hand?: Hand;
}
export interface Arrangements {
  /**
   * Right-hand part, MIDI 60-84.
   */
  easy: Note[];
  /**
   * Plus left-hand root+fifth per bar.
   */
  intermediate?: Note[];
}
/**
 * Sound recipe JSON from Muse Spark Open.
 */
export interface Recipe {
  [k: string]: unknown;
}
export interface FallbackStem {
  name: StemName;
  url: string;
  wav_url?: string;
  level: number;
}
/**
 * Present only for video clips.
 */
export interface Video {
  /**
   * 720p web copy of the clip.
   */
  url: string;
  /**
   * Mask frame rate (10).
   */
  fps: number;
  width: number;
  height: number;
  tracks: VideoTrack[];
}
export interface VideoTrack {
  id: string;
  /**
   * e.g. 'Keyboard player'.
   */
  label: string;
  /**
   * Text prompt or 'tap@x,y' used for SAM 3.1.
   */
  prompt?: string;
  /**
   * JSON with one polygon list per frame.
   */
  masks_url: string;
  /**
   * [start, end] ranges where the object is on screen.
   */
  visible: TimeRange[];
  /**
   * Isolation produced from this track, once requested.
   */
  isolation_id?: string;
}
