import { isLatinScript } from "@/lib/voice-commands";
import { MAX_TRANSCRIPT_CHARS, phraseFromModelReply, RUN_COMMAND_TOOL } from "@/lib/voice-intent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
const MUSE_SPARK_MODEL = "muse-spark-1.2-contributor";
// Reasoning counts towards this, and 400 ran out before many tool calls were written.
const MAX_OUTPUT_TOKENS = 4000;

type VoiceIntentReply = {
  phrase: string | null;
  message?: string;
};

const INSTRUCTIONS = `You are the voice control of Mixray. A musician practising on a keyboard says what they want with both hands on the keys, and you choose the one command that does it. Decide from what they mean, not from single words.
They speak English with an accent, and speech recognition mishears them and may glue words together, so also say the text aloud in your head. "Go back to Barth", "Subarzbek" and "Golbek to bars" are all "back 2 bars". "Next var" is "next bar". "Paws" is "pause". "Plate" is "play".
They also say things in their own way: "take it from the top" and "let's start over" are "from the top". "Just let me hear the bass" is "switch to bass". "That was too fast" is "slower". "Stop repeating" is "loop off". "Keep repeating bars three to six" is "loop 3 to 6". "How was that" is "how did I do". "Where am I" is "which bar".
Always call a tool. Call ${RUN_COMMAND_TOOL} with exactly one of these forms, with the numbers and the name they said filled in:
play, pause, from the top, bar 5, back 2 bars, forward 2 bars, next bar, previous bar, loop 4 to 8, loop 2 bars, loop off, slower, faster, slow to 70 percent, normal speed, solo, the rest, full mix, switch to bass, easy, intermediate, left hand, right hand, both hands, octave up, octave down, how did I do, simplify bar 6, what is the key, what is the tempo, which bar, help.
When they are asking for something, choose the closest command even if they say it loosely or add extra words: a request to wait is "pause", anything repeated "over and over" is a loop, and "only" or "just" with an instrument is "switch to" it, whichever instrument they name.
Call no_command only when they are not asking for anything, such as a remark about the song or about how they played, or for real words of another language such as "iki bar geri".`;

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
