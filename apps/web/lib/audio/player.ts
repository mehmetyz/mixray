export type StemName = "mix" | "sound" | "rest";

export type StemSource = {
  name: StemName;
  url: string;
};

export type LoopRange = {
  startSeconds: number;
  endSeconds: number;
};

export type PlayerEvents = {
  onTime: (seconds: number) => void;
  onEnded: () => void;
};

const CROSSFADE_SECONDS = 0.02;
const DRIFT_TOLERANCE_SECONDS = 0.04;
const TICK_MILLISECONDS = 50;

type Track = {
  element: HTMLAudioElement;
  gain: GainNode;
};

/** Plays the mix, the isolated sound and the rest on one clock.
 *
 *  All three run at once and only their gain changes, so switching is instant and silent. Tempo
 *  comes from the media elements because `preservesPitch` lives there, not on a buffer source. */
export class StemPlayer {
  private readonly context: AudioContext;
  private readonly tracks: Map<StemName, Track>;
  private readonly events: Partial<PlayerEvents>;
  private active: StemName;
  private loop: LoopRange | null = null;
  private ticker: number | null = null;

  constructor(sources: StemSource[], events: Partial<PlayerEvents> = {}) {
    const first = sources[0];
    if (first === undefined) throw new Error("A player needs at least one stem.");

    this.context = new AudioContext();
    this.events = events;
    this.active = first.name;
    this.tracks = new Map();

    for (const source of sources) {
      const element = new Audio(source.url);
      element.crossOrigin = "anonymous";
      element.preload = "auto";
      element.preservesPitch = true;
      const gain = this.context.createGain();
      gain.gain.value = source.name === this.active ? 1 : 0;
      this.context.createMediaElementSource(element).connect(gain).connect(this.context.destination);
      this.tracks.set(source.name, { element, gain });
    }
  }

  get currentTime(): number {
    return this.leader?.element.currentTime ?? 0;
  }

  get duration(): number {
    const value = this.leader?.element.duration ?? 0;
    return Number.isFinite(value) ? value : 0;
  }

  get playing(): boolean {
    const element = this.leader?.element;
    return element !== undefined && !element.paused;
  }

  get activeStem(): StemName {
    return this.active;
  }

  private get leader(): Track | undefined {
    return this.tracks.values().next().value;
  }

  async play(): Promise<void> {
    await this.context.resume();
    await Promise.all([...this.tracks.values()].map((track) => track.element.play()));
    this.startTicking();
  }

  pause(): void {
    for (const track of this.tracks.values()) track.element.pause();
    this.stopTicking();
  }

  seek(seconds: number): void {
    const target = Math.min(Math.max(seconds, 0), this.duration || seconds);
    for (const track of this.tracks.values()) track.element.currentTime = target;
    this.events.onTime?.(target);
  }

  /** Crossfades instead of cutting, so switching never clicks. */
  setActive(name: StemName): void {
    if (!this.tracks.has(name)) return;
    this.active = name;
    const endsAt = this.context.currentTime + CROSSFADE_SECONDS;
    for (const [stem, track] of this.tracks) {
      track.gain.gain.cancelScheduledValues(this.context.currentTime);
      track.gain.gain.setValueAtTime(track.gain.gain.value, this.context.currentTime);
      track.gain.gain.linearRampToValueAtTime(stem === name ? 1 : 0, endsAt);
    }
  }

  setRate(rate: number): void {
    const clamped = Math.min(Math.max(rate, 0.25), 2);
    for (const track of this.tracks.values()) {
      track.element.preservesPitch = true;
      track.element.playbackRate = clamped;
    }
  }

  setLoop(loop: LoopRange | null): void {
    this.loop = loop;
    if (loop !== null && this.currentTime < loop.startSeconds) this.seek(loop.startSeconds);
  }

  async dispose(): Promise<void> {
    this.pause();
    for (const track of this.tracks.values()) {
      track.element.src = "";
      track.gain.disconnect();
    }
    this.tracks.clear();
    await this.context.close();
  }

  private startTicking(): void {
    if (this.ticker !== null) return;
    this.ticker = window.setInterval(() => this.tick(), TICK_MILLISECONDS);
  }

  private stopTicking(): void {
    if (this.ticker === null) return;
    window.clearInterval(this.ticker);
    this.ticker = null;
  }

  private tick(): void {
    const leader = this.leader;
    if (leader === undefined) return;
    const now = leader.element.currentTime;

    if (this.loop !== null && now >= this.loop.endSeconds) {
      this.seek(this.loop.startSeconds);
      return;
    }
    if (leader.element.ended) {
      this.pause();
      this.events.onEnded?.();
      return;
    }

    // Media elements drift apart over time; nudge the followers back onto the leader's clock.
    for (const track of this.tracks.values()) {
      if (track === leader) continue;
      if (Math.abs(track.element.currentTime - now) > DRIFT_TOLERANCE_SECONDS) {
        track.element.currentTime = now;
      }
    }
    this.events.onTime?.(now);
  }
}
