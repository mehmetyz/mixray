import type { Isolation, Note, TrackMap } from "@/lib/trackmap/trackmap.generated";
import { formatPitchRange } from "./format";

export type ZipFileEntry = {
  filename: string;
  data: Uint8Array;
};

type MidiEvent = {
  tick: number;
  bytes: number[];
};

const TICKS_PER_QUARTER = 480;

function writeVarLen(value: number): number[] {
  let v = Math.max(0, Math.floor(value));
  const reversed: number[] = [v & 0x7f];
  v >>= 7;
  while (v > 0) {
    reversed.push((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return reversed.reverse();
}

/** Encodes a Standard MIDI File (Format 0) so exported clips drop straight into any DAW at tempo. */
export function encodeStandardMidi(notes: Note[], bpm: number): ArrayBuffer {
  const safeBpm = Math.max(20, Math.min(300, bpm || 120));
  const microsPerBeat = Math.round(60_000_000 / safeBpm);
  const ticksPerSecond = (TICKS_PER_QUARTER * safeBpm) / 60;

  const events: MidiEvent[] = [];
  for (const note of notes) {
    const startTick = Math.max(0, Math.round(note.start * ticksPerSecond));
    const endTick = Math.max(startTick + 20, Math.round(note.end * ticksPerSecond));
    const pitch = Math.max(0, Math.min(127, Math.round(note.pitch)));
    const velocity = Math.max(1, Math.min(127, Math.round(note.velocity)));
    const channel = note.hand === "left" ? 1 : 0;
    events.push({ tick: startTick, bytes: [0x90 | channel, pitch, velocity] });
    events.push({ tick: endTick, bytes: [0x80 | channel, pitch, 0] });
  }

  events.sort((a, b) => a.tick - b.tick || (a.bytes[0] ?? 0) - (b.bytes[0] ?? 0));

  const trackBytes: number[] = [
    0x00,
    0xff,
    0x51,
    0x03,
    (microsPerBeat >> 16) & 0xff,
    (microsPerBeat >> 8) & 0xff,
    microsPerBeat & 0xff,
  ];

  let prevTick = 0;
  for (const ev of events) {
    const delta = Math.max(0, ev.tick - prevTick);
    prevTick = ev.tick;
    trackBytes.push(...writeVarLen(delta), ...ev.bytes);
  }
  trackBytes.push(0x00, 0xff, 0x2f, 0x00);

  const totalSize = 14 + 8 + trackBytes.length;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  // MThd
  out.set([0x4d, 0x54, 0x68, 0x64], 0);
  view.setUint32(4, 6, false);
  view.setUint16(8, 0, false);
  view.setUint16(10, 1, false);
  view.setUint16(12, TICKS_PER_QUARTER, false);

  // MTrk
  out.set([0x4d, 0x54, 0x72, 0x6b], 14);
  view.setUint32(18, trackBytes.length, false);
  out.set(trackBytes, 22);

  return buffer;
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const tableVal = CRC_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = (crc >>> 8) ^ tableVal;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds an uncompressed PKZIP archive in memory for multi-file Take Home downloads. */
export function encodeStoreZip(entries: ZipFileEntry[]): ArrayBuffer {
  const encoder = new TextEncoder();
  const nameBytesList = entries.map((entry) => encoder.encode(entry.filename));

  let localSize = 0;
  let centralSize = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const nameLen = nameBytesList[index]?.length ?? 0;
    const dataLen = entries[index]?.data.length ?? 0;
    localSize += 30 + nameLen + dataLen;
    centralSize += 46 + nameLen;
  }

  const totalSize = localSize + centralSize + 22;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  const offsets: number[] = [];
  const crcs: number[] = [];
  let cursor = 0;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const nameBytes = nameBytesList[index];
    if (entry === undefined || nameBytes === undefined) continue;

    const checksum = crc32(entry.data);
    offsets.push(cursor);
    crcs.push(checksum);

    view.setUint32(cursor, 0x04034b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 0, true);
    view.setUint16(cursor + 8, 0, true);
    view.setUint16(cursor + 10, 0, true);
    view.setUint16(cursor + 12, 0, true);
    view.setUint32(cursor + 14, checksum, true);
    view.setUint32(cursor + 18, entry.data.length, true);
    view.setUint32(cursor + 22, entry.data.length, true);
    view.setUint16(cursor + 26, nameBytes.length, true);
    view.setUint16(cursor + 28, 0, true);
    out.set(nameBytes, cursor + 30);
    out.set(entry.data, cursor + 30 + nameBytes.length);
    cursor += 30 + nameBytes.length + entry.data.length;
  }

  const centralStart = cursor;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const nameBytes = nameBytesList[index];
    if (entry === undefined || nameBytes === undefined) continue;

    const checksum = crcs[index] ?? 0;
    const localOffset = offsets[index] ?? 0;

    view.setUint32(cursor, 0x02014b50, true);
    view.setUint16(cursor + 4, 20, true);
    view.setUint16(cursor + 6, 20, true);
    view.setUint16(cursor + 8, 0, true);
    view.setUint16(cursor + 10, 0, true);
    view.setUint16(cursor + 12, 0, true);
    view.setUint16(cursor + 14, 0, true);
    view.setUint32(cursor + 16, checksum, true);
    view.setUint32(cursor + 20, entry.data.length, true);
    view.setUint32(cursor + 24, entry.data.length, true);
    view.setUint16(cursor + 28, nameBytes.length, true);
    view.setUint16(cursor + 30, 0, true);
    view.setUint16(cursor + 32, 0, true);
    view.setUint16(cursor + 34, 0, true);
    view.setUint16(cursor + 36, 0, true);
    view.setUint32(cursor + 38, 0, true);
    view.setUint32(cursor + 42, localOffset, true);
    out.set(nameBytes, cursor + 46);
    cursor += 46 + nameBytes.length;
  }

  const centralLen = cursor - centralStart;
  view.setUint32(cursor, 0x06054b50, true);
  view.setUint16(cursor + 4, 0, true);
  view.setUint16(cursor + 6, 0, true);
  view.setUint16(cursor + 8, entries.length, true);
  view.setUint16(cursor + 10, entries.length, true);
  view.setUint32(cursor + 12, centralLen, true);
  view.setUint32(cursor + 16, centralStart, true);
  view.setUint16(cursor + 20, 0, true);

  return buffer;
}

export function formatSessionNotes(trackMap: TrackMap, isolation: Isolation): string {
  const chordLine = trackMap.chords
    .map((chord) => `Bar ${String(chord.bar + 1).padStart(2, "0")}: ${chord.label}`)
    .join("\n");

  return [
    `MIXRAY SESSION EXPORT`,
    `=====================`,
    `Title: ${trackMap.source.title}`,
    `Sound: ${isolation.label} (prompt: "${isolation.prompt}")`,
    `Method: ${isolation.method}`,
    `Tempo: ${Math.round(trackMap.tempo.bpm)} BPM (${trackMap.tempo.time_signature[0]}/${trackMap.tempo.time_signature[1]})`,
    `Key: ${trackMap.key.tonic} ${trackMap.key.mode}`,
    `Pitch range: ${formatPitchRange(isolation.range, isolation.notes)}`,
    ``,
    `Summary:`,
    isolation.summary ?? trackMap.summary ?? "Isolated stem and MIDI transcription.",
    ``,
    `Chords by bar:`,
    chordLine,
    ``,
  ].join("\n");
}

export function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

