import { VOICE_KEYWORDS } from "@/lib/voice-intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const META_TRANSCRIBE_URL = "https://api.meta.ai/v1/asr/transcribe";
const MUSE_VOICE_MODEL = "muse-voice-transcribe-1.0";
const COMMAND_LANGUAGES: readonly string[] = ["English"];
const MAX_AUDIO_SECONDS = 10;
const WAV_MIME_TYPE = "audio/wav";
const WAV_HEADER_BYTES = 12;
const WAV_CHUNK_HEADER_BYTES = 8;

type JsonRecord = Record<string, unknown>;

type VoiceError = {
  message: string;
};

type VoiceTranscript = {
  transcript: string;
};

type WavInfo = {
  seconds: number;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasAscii(view: DataView, offset: number, text: string): boolean {
  if (offset + text.length > view.byteLength) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (view.getUint8(offset + index) !== text.charCodeAt(index)) return false;
  }
  return true;
}

function readWavInfo(buffer: ArrayBuffer): WavInfo | null {
  const view = new DataView(buffer);
  if (
    view.byteLength < WAV_HEADER_BYTES ||
    !hasAscii(view, 0, "RIFF") ||
    !hasAscii(view, 8, "WAVE")
  ) {
    return null;
  }

  let channelCount: number | null = null;
  let sampleRate: number | null = null;
  let bitsPerSample: number | null = null;
  let dataBytes = 0;
  let hasData = false;
  let offset = WAV_HEADER_BYTES;

  while (offset + WAV_CHUNK_HEADER_BYTES <= view.byteLength) {
    const chunkBytes = view.getUint32(offset + 4, true);
    const chunkDataOffset = offset + WAV_CHUNK_HEADER_BYTES;
    if (chunkBytes > view.byteLength - chunkDataOffset) return null;

    if (hasAscii(view, offset, "fmt ")) {
      if (chunkBytes < 16) return null;
      const format = view.getUint16(chunkDataOffset, true);
      if (format !== 1) return null;
      channelCount = view.getUint16(chunkDataOffset + 2, true);
      sampleRate = view.getUint32(chunkDataOffset + 4, true);
      bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
    } else if (hasAscii(view, offset, "data")) {
      dataBytes += chunkBytes;
      hasData = true;
    }

    offset = chunkDataOffset + chunkBytes + (chunkBytes % 2);
  }

  if (
    channelCount !== 1 ||
    (sampleRate !== 16_000 && sampleRate !== 24_000) ||
    bitsPerSample !== 16 ||
    !hasData
  ) {
    return null;
  }

  return { seconds: dataBytes / (sampleRate * 2) };
}

function errorResponse(message: string, status: number): Response {
  const body: VoiceError = { message };
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function parseTranscript(value: unknown): VoiceTranscript | null {
  if (!isRecord(value) || typeof value.transcript !== "string") return null;
  return { transcript: value.transcript.trim() };
}

export async function POST(request: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorResponse("Send a WAV recording.", 400);
  }

  const upload = form.get("audio");
  if (upload === null || typeof upload === "string") {
    return errorResponse("Attach a WAV recording.", 400);
  }
  if (upload.type !== WAV_MIME_TYPE) {
    return errorResponse("Use a WAV recording.", 400);
  }

  const wavInfo = readWavInfo(await upload.arrayBuffer());
  if (wavInfo === null) {
    return errorResponse("Use a mono PCM WAV recording.", 400);
  }
  if (wavInfo.seconds > MAX_AUDIO_SECONDS) {
    return errorResponse("Voice recordings can be at most 10 seconds.", 400);
  }

  const apiKey = process.env.META_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return errorResponse("Voice transcription is not configured.", 503);
  }

  // The endpoint wants exactly two parts, a JSON `request` and the `audio` file. Flat form fields
  // are rejected with "Both a 'request' and an 'audio' part are required", measured on the first
  // live call. Without `languageBias` the model guesses the language and wrote accented English as
  // German or Korean; `keywords` steers it to the command words ("bass", not "bus").
  const upstreamForm = new FormData();
  upstreamForm.append(
    "request",
    new Blob(
      [
        JSON.stringify({
          model: MUSE_VOICE_MODEL,
          mode: "PUSH_TO_TALK",
          audioEncoding: "WAV",
          languageBias: COMMAND_LANGUAGES,
          keywords: VOICE_KEYWORDS,
        }),
      ],
      { type: "application/json" },
    ),
  );
  upstreamForm.append("audio", upload, "voice-command.wav");

  let upstream: Response;
  try {
    upstream = await fetch(META_TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstreamForm,
    });
  } catch (error) {
    // The reason has to be logged, not only shown as "unavailable": a swallowed upstream failure
    // is indistinguishable from a rejected microphone, and the first live run proved it.
    console.error("voice transcription request failed", error);
    return errorResponse("Voice transcription is unavailable. Try again.", 502);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("voice transcription returned", upstream.status, detail.slice(0, 500));
    return errorResponse("Voice transcription is unavailable. Try again.", 502);
  }

  let reply: unknown;
  try {
    reply = await upstream.json();
  } catch {
    return errorResponse("The voice transcript could not be read. Try again.", 502);
  }

  const transcript = parseTranscript(reply);
  if (transcript === null) {
    return errorResponse("The voice transcript could not be read. Try again.", 502);
  }

  return Response.json(transcript, { headers: { "cache-control": "no-store" } });
}
