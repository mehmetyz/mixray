import { isLatinScript } from "@/lib/voice-commands";
import { MAX_TRANSCRIPT_CHARS, phraseFromModelReply, RUN_COMMAND_TOOL } from "@/lib/voice-intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
const MUSE_SPARK_MODEL = "muse-spark-1.2-contributor";
const MAX_OUTPUT_TOKENS = 400;

type VoiceIntentReply = {
  phrase: string | null;
  message?: string;
};

const INSTRUCTIONS = `You read one spoken command from a musician practising on a keyboard in Mixray. Both hands are on the keys, so a command that is ignored stops their practice.
The text comes from speech recognition, which badly mishears accented English and may glue words together. Say the text aloud in your head and pick the command it sounds closest to. Examples: "Go back to Barth" is "back 2 bars". "Subarzbek" is "back 2 bars". "Golbek to bars" is "back 2 bars". "Next var" is "next bar". "Paws" is "pause". "Plate" is "play".
Always call a tool. Call ${RUN_COMMAND_TOOL} with one of these forms, with the numbers filled in:
play, pause, from the top, bar 5, back 2 bars, forward 2 bars, next bar, previous bar, loop 4 to 8, loop 2 bars, loop off, slower, faster, slow to 70 percent, normal speed, solo, the rest, full mix, switch to bass, easy, intermediate, left hand, right hand, both hands, octave up, octave down, how did I do, simplify bar 6, what is the key, what is the tempo, which bar, help.
Call no_command only for an ordinary sentence about something else, or for real words of another language such as "iki bar geri".`;

const TOOLS = [
  {
    type: "function",
    name: RUN_COMMAND_TOOL,
    description: "Run the command the musician meant.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["phrase"],
      properties: { phrase: { type: "string" } },
    },
    strict: true,
  },
  {
    type: "function",
    name: "no_command",
    description: "The text is not a command in English.",
    parameters: { type: "object", additionalProperties: false, properties: {} },
    strict: true,
  },
] as const;

function reply(body: VoiceIntentReply, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function transcriptFrom(body: unknown): string | null {
  if (typeof body !== "object" || body === null || !("transcript" in body)) return null;
  if (typeof body.transcript !== "string") return null;
  const transcript = body.transcript.trim();
  return transcript.length > 0 && transcript.length <= MAX_TRANSCRIPT_CHARS ? transcript : null;
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return reply({ phrase: null, message: "Send a transcript." }, 400);
  }
  const transcript = transcriptFrom(body);
  if (transcript === null) return reply({ phrase: null, message: "Send a transcript." }, 400);
  if (!isLatinScript(transcript)) return reply({ phrase: null });

  const apiKey = process.env.META_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return reply({ phrase: null, message: "Voice is not configured." }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(META_RESPONSES_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MUSE_SPARK_MODEL,
        instructions: INSTRUCTIONS,
        input: [{ role: "user", content: [{ type: "input_text", text: transcript }] }],
        tools: TOOLS,
        tool_choice: "auto",
        max_output_tokens: MAX_OUTPUT_TOKENS,
        store: false,
      }),
    });
  } catch (error) {
    console.error("voice intent request failed", error);
    return reply({ phrase: null, message: "Voice is unavailable. Try again." }, 502);
  }
  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    console.error("voice intent returned", upstream.status, detail.slice(0, 500));
    return reply({ phrase: null, message: "Voice is unavailable. Try again." }, 502);
  }

  const modelReply: unknown = await upstream.json().catch(() => null);
  return reply({ phrase: phraseFromModelReply(modelReply) });
}
