export type Earcon = "listening" | "done" | "unknown";

const TONES: Record<Earcon, readonly number[]> = {
  listening: [587.33, 880],
  done: [659.25, 987.77],
  unknown: [392, 293.66],
};
const TONE_SECONDS = 0.09;
const LEVEL = 0.1;

let context: AudioContext | null = null;

/**
 * Short sounds instead of a spoken reply. Meta's API has no text-to-speech, and a system voice says
 * little that a player with both hands busy needs: only that the command was heard, or was not.
 */
export function playEarcon(earcon: Earcon): void {
  if (typeof window === "undefined") return;
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  const start = context.currentTime;
  TONES[earcon].forEach((frequency, index) => {
    if (context === null) return;
    const at = start + index * TONE_SECONDS;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(LEVEL, at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + TONE_SECONDS);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start(at);
    oscillator.stop(at + TONE_SECONDS);
  });
}
