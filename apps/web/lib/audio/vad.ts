export type SpeechGateEvent = "started" | "ended" | "discarded";

const MIN_LEVEL = 0.012;
const NOISE_RATIO = 3;
const NOISE_SMOOTHING = 0.05;
const ONSET_SECONDS = 0.12;
const HANG_SECONDS = 0.7;
const MIN_SPEECH_SECONDS = 0.35;
export const MAX_SPEECH_SECONDS = 9;

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

  push(level: number, seconds: number): SpeechGateEvent | null {
    const isLoud = level > Math.max(MIN_LEVEL, this.noise * NOISE_RATIO);

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
      return "started";
    }

    this.spokenFor += seconds;
    this.quietFor = isLoud ? 0 : this.quietFor + seconds;
    if (this.quietFor < HANG_SECONDS && this.spokenFor < MAX_SPEECH_SECONDS) return null;
    const voiced = this.spokenFor - this.quietFor;
    this.reset();
    return voiced >= MIN_SPEECH_SECONDS ? "ended" : "discarded";
  }

  reset(): void {
    this.loudFor = 0;
    this.quietFor = 0;
    this.spokenFor = 0;
    this.inSpeech = false;
  }
}
