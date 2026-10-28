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

export function lookupShortcutKey(key: string): PianoKeySpec | undefined {
  return SHORTCUT_MAP.get(key.toLowerCase());
}

/** Audible low-latency monitor voice for on-screen, QWERTY and Web MIDI practice keys. */
export function playMonitorNote(midi: number, durationSeconds = 0.28): void {
  const ctx = getSynthContext();
  if (ctx === null) return;

  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  osc.type = "triangle";
  osc.frequency.setValueAtTime(440 * Math.pow(2, (midi - 69) / 12), now);

  filter.type = "lowpass";
  filter.frequency.setValueAtTime(2800, now);

  gain.gain.setValueAtTime(0.001, now);
  gain.gain.linearRampToValueAtTime(0.14, now + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0008, now + durationSeconds);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);

  osc.start(now);
  osc.stop(now + durationSeconds + 0.02);
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

