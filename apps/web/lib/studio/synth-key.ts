export type PianoKeySpec = {
  midi: number;
  note: string;
  isSharp: boolean;
  shortcut: string;
};

export type MidiDeviceOption = {
  id: string;
  name: string;
};

export type MidiNoteCallback = (midi: number, velocity: number) => void;
export type MidiDevicesCallback = (devices: MidiDeviceOption[]) => void;

export const TWO_OCTAVE_KEYS: readonly PianoKeySpec[] = [
  { midi: 60, note: "C4", isSharp: false, shortcut: "A" },
  { midi: 61, note: "C#4", isSharp: true, shortcut: "W" },
  { midi: 62, note: "D4", isSharp: false, shortcut: "S" },
  { midi: 63, note: "D#4", isSharp: true, shortcut: "E" },
  { midi: 64, note: "E4", isSharp: false, shortcut: "D" },
  { midi: 65, note: "F4", isSharp: false, shortcut: "F" },
  { midi: 66, note: "F#4", isSharp: true, shortcut: "T" },
  { midi: 67, note: "G4", isSharp: false, shortcut: "G" },
  { midi: 68, note: "G#4", isSharp: true, shortcut: "Y" },
  { midi: 69, note: "A4", isSharp: false, shortcut: "H" },
  { midi: 70, note: "A#4", isSharp: true, shortcut: "U" },
  { midi: 71, note: "B4", isSharp: false, shortcut: "J" },
  { midi: 72, note: "C5", isSharp: false, shortcut: "K" },
  { midi: 73, note: "C#5", isSharp: true, shortcut: "O" },
  { midi: 74, note: "D5", isSharp: false, shortcut: "L" },
  { midi: 75, note: "D#5", isSharp: true, shortcut: "P" },
  { midi: 76, note: "E5", isSharp: false, shortcut: ";" },
  { midi: 77, note: "F5", isSharp: false, shortcut: "'" },
  { midi: 78, note: "F#5", isSharp: true, shortcut: "" },
  { midi: 79, note: "G5", isSharp: false, shortcut: "]" },
  { midi: 80, note: "G#5", isSharp: true, shortcut: "" },
  { midi: 81, note: "A5", isSharp: false, shortcut: "" },
  { midi: 82, note: "A#5", isSharp: true, shortcut: "" },
  { midi: 83, note: "B5", isSharp: false, shortcut: "" },
];

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

export function formatKeyNoteName(midi: number): string {
  const note = NOTE_NAMES[midi % 12] ?? "C";
  const octave = Math.floor(midi / 12) - 1;
  return `${note}${octave}`;
}

export function buildPianoKeys(octaveShift: number = 0): PianoKeySpec[] {
  const offset = octaveShift * 12;
  return TWO_OCTAVE_KEYS.map((k) => {
    const shiftedMidi = Math.max(12, Math.min(108, k.midi + offset));
    return {
      midi: shiftedMidi,
      note: formatKeyNoteName(shiftedMidi),
      isSharp: k.isSharp,
      shortcut: k.shortcut,
    };
  });
}

const SHORTCUT_MAP = new Map<string, PianoKeySpec>(
  TWO_OCTAVE_KEYS.filter((item) => item.shortcut.length > 0).map((item) => [
    item.shortcut.toLowerCase(),
    item,
  ]),
);

let sharedAudioContext: AudioContext | null = null;

function getSynthContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (sharedAudioContext === null) {
    sharedAudioContext = new AudioContext();
  }
  if (sharedAudioContext.state === "suspended") {
    void sharedAudioContext.resume();
  }
  return sharedAudioContext;
}

export function lookupShortcutKey(key: string, octaveShift: number = 0): PianoKeySpec | undefined {
  const base = SHORTCUT_MAP.get(key.toLowerCase());
  if (base === undefined) return undefined;
  if (octaveShift === 0) return base;
  const shiftedMidi = Math.max(12, Math.min(108, base.midi + octaveShift * 12));
  return {
    ...base,
    midi: shiftedMidi,
    note: formatKeyNoteName(shiftedMidi),
  };
}

type ActiveVoice = {
  oscMain: OscillatorNode;
  oscBody: OscillatorNode;
  filter: BiquadFilterNode;
  gain: GainNode;
  stopTimeout: number;
};

const activeVoices = new Map<number, ActiveVoice>();

/** Starts sounding a note with warm, full-bodied studio tone and sustains it until `stopMonitorNote`. */
export function startMonitorNote(midi: number): void {
  const ctx = getSynthContext();
  if (ctx === null) return;

  // Release any existing voice on this pitch first
  stopMonitorNote(midi);

  const now = ctx.currentTime;
  const oscMain = ctx.createOscillator();
  const oscBody = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();
  const bodyGain = ctx.createGain();

  const freq = 440 * Math.pow(2, (midi - 69) / 12);

  // 1. Main melodic oscillator: warm triangle for clean fundamental pitch
  oscMain.type = "triangle";
  oscMain.frequency.setValueAtTime(freq, now);

  // 2. Body/Sub reinforcement oscillator: deep sine wave at 1 octave lower (for midi >= 45)
  // or fundamental (for bass notes) to create rich, warm, "tok" low-end depth
  const bodyFreq = midi >= 45 ? freq * 0.5 : freq;
  oscBody.type = "sine";
  oscBody.frequency.setValueAtTime(bodyFreq, now);

  // 3. Dynamic acoustic lowpass filter:
  // Starts slightly open (1900 Hz, Q: 1.2) for crisp finger/hammer attack,
  // then smoothly rolls off to warm 950 Hz so the note stays round, punchy and never shrill
  filter.type = "lowpass";
  filter.Q.setValueAtTime(1.2, now);
  filter.frequency.setValueAtTime(1900, now);
  filter.frequency.exponentialRampToValueAtTime(950, now + 0.12);

  // 4. Punchy attack & sustain envelope
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.linearRampToValueAtTime(0.18, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.09);

  // Mix 40% body reinforcement with the main oscillator
  bodyGain.gain.setValueAtTime(0.40, now);
  oscBody.connect(bodyGain).connect(filter);
  oscMain.connect(filter);

  filter.connect(gain).connect(ctx.destination);

  oscMain.start(now);
  oscBody.start(now);

  // Auto safety release after 4.5 seconds if key-up is never received
  const stopTimeout = window.setTimeout(() => {
    stopMonitorNote(midi);
  }, 4500);

  activeVoices.set(midi, { oscMain, oscBody, filter, gain, stopTimeout });
}

/** Smoothly releases a sounding sustained note. */
export function stopMonitorNote(midi: number): void {
  const voice = activeVoices.get(midi);
  if (!voice) return;
  activeVoices.delete(midi);
  window.clearTimeout(voice.stopTimeout);

  const ctx = getSynthContext();
  if (ctx === null) return;
  const now = ctx.currentTime;

  try {
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.exponentialRampToValueAtTime(0.0008, now + 0.09);
    voice.oscMain.stop(now + 0.11);
    voice.oscBody.stop(now + 0.11);
  } catch {
    // Context may already be closed
  }
}

/** Audible low-latency monitor voice for on-screen, QWERTY and Web MIDI practice keys. */
export function playMonitorNote(midi: number, durationSeconds = 0.28): void {
  startMonitorNote(midi);
  window.setTimeout(() => {
    stopMonitorNote(midi);
  }, durationSeconds * 1000);
}

/** Connects to Web MIDI inputs when supported by the browser. */
export function subscribeWebMidi(
  selectedDeviceId: string,
  onNoteOn: MidiNoteCallback,
  onDevices: MidiDevicesCallback,
): () => void {
  if (typeof navigator === "undefined" || typeof navigator.requestMIDIAccess !== "function") {
    onDevices([]);
    return () => {};
  }

  let disposed = false;
  let activeAccess: MIDIAccess | null = null;

  const syncInputs = (access: MIDIAccess) => {
    if (disposed) return;
    const devices: MidiDeviceOption[] = [];
    for (const input of access.inputs.values()) {
      devices.push({
        id: input.id,
        name: input.name ?? "MIDI Keyboard",
      });
      input.onmidimessage = (event: MIDIMessageEvent) => {
        if (disposed) return;
        if (selectedDeviceId !== "all" && selectedDeviceId !== "qwerty" && input.id !== selectedDeviceId) {
          return;
        }
        const bytes = event.data;
        if (bytes === null || bytes.length < 3) return;
        const status = (bytes[0] ?? 0) & 0xf0;
        const note = bytes[1] ?? 0;
        const velocity = bytes[2] ?? 0;
        if (status === 0x90 && velocity > 0) {
          onNoteOn(note, velocity);
        }
      };
    }
    onDevices(devices);
  };

  void navigator
    .requestMIDIAccess()
    .then((access) => {
      if (disposed) return;
      activeAccess = access;
      syncInputs(access);
      access.onstatechange = () => syncInputs(access);
    })
    .catch(() => {
      if (!disposed) onDevices([]);
    });

  return () => {
    disposed = true;
    if (activeAccess !== null) {
      activeAccess.onstatechange = null;
      for (const input of activeAccess.inputs.values()) {
        input.onmidimessage = null;
      }
    }
  };
}

