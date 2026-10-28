/**
 * Unified MIDI input library: Web MIDI + on-screen keys + QWERTY shortcuts
 * merged into a single note stream aligned to the audio playback clock.
 */

import type { ScoreNote } from "./score";

export type MidiSource = "web_midi" | "screen" | "qwerty";

export type LiveNoteKind = "note_on" | "note_off";

export type LiveNoteEvent = {
  kind: LiveNoteKind;
  pitch: number;
  velocity: number;
  onsetSeconds: number;
  source: MidiSource;
  deviceId?: string;
};

export type CompletedNote = {
  pitch: number;
  velocity: number;
  onsetSeconds: number;
  durationSeconds: number;
  source: MidiSource;
};

export type ClockProvider = () => number;

export type NoteListener = (event: LiveNoteEvent) => void;

export type MidiDevice = {
  id: string;
  name: string;
};

export type DeviceChangeListener = (devices: MidiDevice[]) => void;

export type NoteStreamOptions = {
  selectedDeviceId?: string;
  defaultVelocity?: number;
};

export type NoteStream = {
  emitNoteOn: (pitch: number, velocity?: number, source?: MidiSource) => void;
  emitNoteOff: (pitch: number, source?: MidiSource) => void;
  feedMidiBytes: (bytes: Uint8Array | number[], deviceId?: string) => LiveNoteEvent | null;
  subscribe: (listener: NoteListener) => () => void;
  startRecording: () => void;
  stopRecording: () => ScoreNote[];
  getRecordedNotes: () => ScoreNote[];
  getCompletedNotes: () => CompletedNote[];
  clearRecording: () => void;
  isRecording: () => boolean;
  dispose: () => void;
};

const MIDI_STATUS_NOTE_OFF: number = 0x80;
const MIDI_STATUS_NOTE_ON: number = 0x90;
const MIDI_STATUS_MASK: number = 0xf0;
const MIDI_NOTE_MIN: number = 0;
const MIDI_NOTE_MAX: number = 127;
const DEFAULT_ON_VELOCITY: number = 96;

type ActiveHeldNote = {
  pitch: number;
  velocity: number;
  onsetSeconds: number;
  source: MidiSource;
};

/**
 * Parses raw MIDI byte data into a LiveNoteEvent aligned to the provided clock.
 * Returns null if the byte sequence is not a Note On or Note Off command.
 */
export function parseMidiBytes(
  bytes: Uint8Array | readonly number[],
  clockSeconds: number,
  deviceId?: string,
): LiveNoteEvent | null {
  if (bytes.length < 3) {
    return null;
  }
  const firstByte = bytes[0];
  const secondByte = bytes[1];
  const thirdByte = bytes[2];
  if (firstByte === undefined || secondByte === undefined || thirdByte === undefined) {
    return null;
  }

  const command = firstByte & MIDI_STATUS_MASK;
  const pitch = Math.max(MIDI_NOTE_MIN, Math.min(MIDI_NOTE_MAX, secondByte));
  const rawVelocity = Math.max(0, Math.min(127, thirdByte));
  const timestamp = Math.max(0, clockSeconds);

  if (command === MIDI_STATUS_NOTE_ON && rawVelocity > 0) {
    const event: LiveNoteEvent = {
      kind: "note_on",
      pitch,
      velocity: rawVelocity,
      onsetSeconds: timestamp,
      source: "web_midi",
    };
    if (deviceId !== undefined) {
      event.deviceId = deviceId;
    }
    return event;
  }

  if (command === MIDI_STATUS_NOTE_OFF || (command === MIDI_STATUS_NOTE_ON && rawVelocity === 0)) {
    const event: LiveNoteEvent = {
      kind: "note_off",
      pitch,
      velocity: 0,
      onsetSeconds: timestamp,
      source: "web_midi",
    };
    if (deviceId !== undefined) {
      event.deviceId = deviceId;
    }
    return event;
  }

  return null;
}

/**
 * Creates a unified NoteStream that receives notes from Web MIDI, on-screen keys,
 * or keyboard shortcuts and timestamps each note with the audio clock.
 */
export function createNoteStream(
  clock: ClockProvider,
  options: NoteStreamOptions = {},
): NoteStream {
  const defaultVelocity = options.defaultVelocity ?? DEFAULT_ON_VELOCITY;
  const listeners: Set<NoteListener> = new Set();
  const activeNotes: Map<number, ActiveHeldNote> = new Map();
  const recordedTake: ScoreNote[] = [];
  const completedNotes: CompletedNote[] = [];
  let recording: boolean = false;
  let disposed: boolean = false;

  const notify = (event: LiveNoteEvent): void => {
    if (disposed) return;
    for (const listener of listeners) {
      listener(event);
    }
  };

  const emitNoteOn = (
    pitch: number,
    velocity: number = defaultVelocity,
    source: MidiSource = "screen",
  ): void => {
    if (disposed) return;
    const clampedPitch = Math.max(MIDI_NOTE_MIN, Math.min(MIDI_NOTE_MAX, Math.round(pitch)));
    const clampedVelocity = Math.max(1, Math.min(127, Math.round(velocity)));
    const timestamp = Math.max(0, clock());

    const active = activeNotes.get(clampedPitch);
    if (active !== undefined) {
      // Complete previous unreleased note at the current timestamp
      const duration = Math.max(0.01, timestamp - active.onsetSeconds);
      completedNotes.push({
        pitch: active.pitch,
        velocity: active.velocity,
        onsetSeconds: active.onsetSeconds,
        durationSeconds: duration,
        source: active.source,
      });
    }

    activeNotes.set(clampedPitch, {
      pitch: clampedPitch,
      velocity: clampedVelocity,
      onsetSeconds: timestamp,
      source,
    });

    if (recording) {
      recordedTake.push({
        onsetSeconds: timestamp,
        pitch: clampedPitch,
      });
    }

    notify({
      kind: "note_on",
      pitch: clampedPitch,
      velocity: clampedVelocity,
      onsetSeconds: timestamp,
      source,
    });
  };

  const emitNoteOff = (
    pitch: number,
    source: MidiSource = "screen",
  ): void => {
    if (disposed) return;
    const clampedPitch = Math.max(MIDI_NOTE_MIN, Math.min(MIDI_NOTE_MAX, Math.round(pitch)));
    const timestamp = Math.max(0, clock());

    const active = activeNotes.get(clampedPitch);
    if (active !== undefined) {
      const duration = Math.max(0.01, timestamp - active.onsetSeconds);
      completedNotes.push({
        pitch: active.pitch,
        velocity: active.velocity,
        onsetSeconds: active.onsetSeconds,
        durationSeconds: duration,
        source: active.source,
      });
      activeNotes.delete(clampedPitch);
    }

    notify({
      kind: "note_off",
      pitch: clampedPitch,
      velocity: 0,
      onsetSeconds: timestamp,
      source,
    });
  };

  const feedMidiBytes = (
    bytes: Uint8Array | number[],
    deviceId?: string,
  ): LiveNoteEvent | null => {
    if (disposed) return null;
    const event = parseMidiBytes(bytes, clock(), deviceId);
    if (event === null) return null;

    if (event.kind === "note_on") {
      emitNoteOn(event.pitch, event.velocity, "web_midi");
    } else {
      emitNoteOff(event.pitch, "web_midi");
    }
    return event;
  };

  const subscribe = (listener: NoteListener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const startRecording = (): void => {
    recordedTake.length = 0;
    completedNotes.length = 0;
    recording = true;
  };

  const stopRecording = (): ScoreNote[] => {
    recording = false;
    // Finalize any currently held notes
    const timestamp = Math.max(0, clock());
    for (const active of activeNotes.values()) {
      const duration = Math.max(0.01, timestamp - active.onsetSeconds);
      completedNotes.push({
        pitch: active.pitch,
        velocity: active.velocity,
        onsetSeconds: active.onsetSeconds,
        durationSeconds: duration,
        source: active.source,
      });
    }
    activeNotes.clear();
    return [...recordedTake].sort((a, b) => a.onsetSeconds - b.onsetSeconds);
  };

  const getRecordedNotes = (): ScoreNote[] => {
    return [...recordedTake].sort((a, b) => a.onsetSeconds - b.onsetSeconds);
  };

  const getCompletedNotes = (): CompletedNote[] => {
    return [...completedNotes].sort((a, b) => a.onsetSeconds - b.onsetSeconds);
  };

  const clearRecording = (): void => {
    recordedTake.length = 0;
    completedNotes.length = 0;
  };

  const isRecording = (): boolean => recording;

  const dispose = (): void => {
    disposed = true;
    listeners.clear();
    activeNotes.clear();
    recordedTake.length = 0;
    completedNotes.length = 0;
  };

  return {
    emitNoteOn,
    emitNoteOff,
    feedMidiBytes,
    subscribe,
    startRecording,
    stopRecording,
    getRecordedNotes,
    getCompletedNotes,
    clearRecording,
    isRecording,
    dispose,
  };
}

/**
 * Connects to Web MIDI inputs when supported by the host browser.
 * Feeds incoming MIDI messages directly into the note stream.
 */
export function connectWebMidi(
  stream: NoteStream,
  onDevices: DeviceChangeListener,
  selectedDeviceId: string = "all",
): () => void {
  if (typeof navigator === "undefined" || typeof navigator.requestMIDIAccess !== "function") {
    onDevices([]);
    return () => { };
  }

  let active: boolean = true;
  let activeAccess: MIDIAccess | null = null;

  const syncDevices = (access: MIDIAccess): void => {
    if (!active) return;
    const devices: MidiDevice[] = [];
    for (const input of access.inputs.values()) {
      devices.push({
        id: input.id,
        name: input.name ?? "MIDI Keyboard",
      });
      input.onmidimessage = (event: MIDIMessageEvent) => {
        if (!active) return;
        if (
          selectedDeviceId !== "all" &&
          selectedDeviceId !== "qwerty" &&
          input.id !== selectedDeviceId
        ) {
          return;
        }
        const data = event.data;
        if (data === null || data.length < 3) return;
        stream.feedMidiBytes(data, input.id);
      };
    }
    onDevices(devices);
  };

  void navigator
    .requestMIDIAccess()
    .then((access) => {
      if (!active) return;
      activeAccess = access;
      syncDevices(access);
      access.onstatechange = () => syncDevices(access);
    })
    .catch(() => {
      if (active) onDevices([]);
    });

  return () => {
    active = false;
    if (activeAccess !== null) {
      activeAccess.onstatechange = null;
      for (const input of activeAccess.inputs.values()) {
        input.onmidimessage = null;
      }
    }
  };
}

