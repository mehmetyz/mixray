export type SpeechGateEvent = "started" | "ended" | "discarded";

const MIN_LEVEL = 0.006;
const NOISE_RATIO = 2;
// A voice this far below its own peak has stopped, even with music still in the room.
const END_RATIO = 0.2;
// Someone already talking while the room is measured must not raise the bar above their voice.
const MAX_ROOM_LEVEL = 0.05;
const NOISE_SMOOTHING = 0.05;
const ONSET_SECONDS = 0.12;
// Long enough for a breath between words, so "loop bars ... five to eight" arrives in one piece.
const HANG_SECONDS = 0.8;
const MIN_SPEECH_SECONDS = 0.2;
export const MAX_SPEECH_SECONDS = 4.5;

/**
 * Decides when someone is speaking from microphone loudness alone: louder than an adapting room
 * level for a moment starts a phrase, and a pause ends it. It runs in the browser so that silence and
 * steady room noise are never sent to the transcription model.
 */
export class SpeechGate {
  private noise = MIN_LEVEL / NOISE_RATIO;
  private loudFor = 0;
  private quietFor = 0;
  private spokenFor = 0;
  private inSpeech = false;
  private peak = 0;

  /** The microphone only opens on a press, so the room has to be measured before anyone speaks. */
  learnRoom(level: number): void {
    this.noise = Math.max(this.noise, Math.min(level, MAX_ROOM_LEVEL));
  }

  push(level: number, seconds: number): SpeechGateEvent | null {
    const threshold = Math.max(MIN_LEVEL, this.noise * NOISE_RATIO);
    const isLoud = level > threshold;

    if (!this.inSpeech) {
      if (!isLoud) {
        this.noise += (level - this.noise) * NOISE_SMOOTHING;
        this.loudFor = 0;
        return null;
      }
      this.loudFor += seconds;
      if (this.loudFor < ONSET_SECONDS) return null;
      this.inSpeech = true;
      this.spokenFor = this.loudFor;
      this.quietFor = 0;
      this.peak = level;
      return "started";
    }

    this.peak = Math.max(this.peak, level);
    this.spokenFor += seconds;
    this.quietFor = level > Math.max(threshold, this.peak * END_RATIO) ? 0 : this.quietFor + seconds;
    if (this.quietFor < HANG_SECONDS && this.spokenFor < MAX_SPEECH_SECONDS) return null;
    const voiced = this.spokenFor - this.quietFor;
    this.reset();
    return voiced >= MIN_SPEECH_SECONDS ? "ended" : "discarded";
  }

  reset(): void {
    this.loudFor = 0;
    this.quietFor = 0;
    this.spokenFor = 0;
    this.peak = 0;
    this.inSpeech = false;
  }
}
