export const VOICE_INTENT_ENDPOINT = "/api/voice/intent";
export const MAX_TRANSCRIPT_CHARS = 200;
export const RUN_COMMAND_TOOL = "run_command";
/**
 * Words the commands are built from, sent to Muse Voice Transcribe as `keywords`. Measured on 60
 * synthesised commands in six accents: with an English `languageBias`, this list and 0.4 s of silence
 * around the voice, exact transcripts went from 22 to 47.
 */
export const VOICE_KEYWORDS: readonly string[] = [
  "play", "pause", "from the top", "bar", "bars", "back", "forward", "next bar", "previous bar", "loop",
  "loop off", "slower", "faster", "percent", "normal speed", "solo", "the rest", "full mix", "switch to",
  "bass", "easy", "intermediate", "left hand", "right hand", "both hands", "octave up", "octave down",
  "simplify", "key", "tempo", "help",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function phraseFromArguments(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const args: unknown = JSON.parse(raw);
    if (!isRecord(args) || typeof args.phrase !== "string") return null;
    const phrase = args.phrase.trim();
    return phrase.length > 0 && phrase.length <= MAX_TRANSCRIPT_CHARS ? phrase : null;
  } catch {
    return null;
  }
}

/** The phrase Muse Spark chose, or null when it said this was not a command. */
export function phraseFromModelReply(reply: unknown): string | null {
  if (!isRecord(reply) || !Array.isArray(reply.output)) return null;
  for (const item of reply.output) {
    if (isRecord(item) && item.type === "function_call" && item.name === RUN_COMMAND_TOOL) {
      return phraseFromArguments(item.arguments);
    }
  }
  return null;
}

/** Asks what a transcript the parser could not read was meant to be. Any failure is simply no answer. */
export async function requestVoiceIntent(transcript: string): Promise<string | null> {
  try {
    const response = await fetch(VOICE_INTENT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript }),
    });
    if (!response.ok) return null;
    const reply: unknown = await response.json();
    return isRecord(reply) && typeof reply.phrase === "string" ? reply.phrase : null;
  } catch {
    return null;
  }
}
