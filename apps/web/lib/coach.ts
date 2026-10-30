import type { ScoreBar } from "./score";

export type HandFilter = "right" | "left" | "both";

export type SetLoopArgs = {
  start_bar: number;
  end_bar: number;
};

export type SetTempoArgs = {
  percent: number;
};

export type SwitchHandArgs = {
  hand: HandFilter;
};

export type SimplifyBarArgs = {
  bar: number;
};

export type MarkProblemBarArgs = {
  bar: number;
  reason: string;
};

export type SetLoopAction = {
  name: "set_loop";
  args: SetLoopArgs;
};

export type SetTempoAction = {
  name: "set_tempo";
  args: SetTempoArgs;
};

export type SwitchHandAction = {
  name: "switch_hand";
  args: SwitchHandArgs;
};

export type SimplifyBarAction = {
  name: "simplify_bar";
  args: SimplifyBarArgs;
};

export type MarkProblemBarAction = {
  name: "mark_problem_bar";
  args: MarkProblemBarArgs;
};

/** Fixed Coach tool contract from SPEC.md §3. */
export type CoachAction =
  | SetLoopAction
  | SetTempoAction
  | SwitchHandAction
  | SimplifyBarAction
  | MarkProblemBarAction;

export type CoachReply = {
  message: string;
  actions: CoachAction[];
};

type JsonRecord = Record<string, unknown>;

const DEFAULT_COACH_MESSAGE = "Focus on one bar at a time, then try the passage again.";
export const INVALID_COACH_REPLY_MESSAGE = "The Coach reply could not be read. Try again.";

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isBarNumber(value: unknown, barCount: number): value is number {
  return isInteger(value) && value >= 1 && value <= barCount;
}

function parseToolArguments(value: unknown): JsonRecord | null {
  if (typeof value !== "string") return null;

  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toCoachAction(name: unknown, argumentsJson: unknown, barCount: number): CoachAction | null {
  const args = parseToolArguments(argumentsJson);
  if (args === null || typeof name !== "string") return null;

  if (name === "set_loop") {
    const startBar = args.start_bar;
    const endBar = args.end_bar;
    if (!isBarNumber(startBar, barCount) || !isBarNumber(endBar, barCount)) return null;
    return {
      name,
      args: {
        start_bar: Math.min(startBar, endBar),
        end_bar: Math.max(startBar, endBar),
      },
    };
  }

  if (name === "set_tempo") {
    if (!isInteger(args.percent)) return null;
    return { name, args: { percent: Math.max(40, Math.min(100, args.percent)) } };
  }

  if (name === "switch_hand") {
    const hand = args.hand;
    if (hand !== "right" && hand !== "left" && hand !== "both") return null;
    return { name, args: { hand } };
  }

  if (name === "simplify_bar") {
    if (!isBarNumber(args.bar, barCount)) return null;
    return { name, args: { bar: args.bar } };
  }

  if (name === "mark_problem_bar") {
    if (!isBarNumber(args.bar, barCount) || typeof args.reason !== "string") return null;
    const reason = args.reason.trim();
    if (reason.length === 0) return null;
    return { name, args: { bar: args.bar, reason: reason.slice(0, 280) } };
  }

  return null;
}

function messageFromOutput(output: unknown[]): string | null {
  const messages: string[] = [];

  for (const item of output) {
    if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (!isRecord(content) || content.type !== "output_text" || typeof content.text !== "string") {
        continue;
      }
      const text = content.text.trim();
      if (text.length > 0) messages.push(text);
    }
  }

  const message = messages.join(" ").trim();
  return message.length > 0 ? message.slice(0, 1000) : null;
}

/**
 * Treat a Meta Responses body as untrusted input and preserve only the fixed Coach contract.
 * The Responses API returns function calls in `output` as `{ type, name, arguments }`.
 */
export function parseCoachModelReply(reply: unknown, barCount: number): CoachReply {
  if (!isInteger(barCount) || barCount < 1 || !isRecord(reply) || !Array.isArray(reply.output)) {
    return { message: INVALID_COACH_REPLY_MESSAGE, actions: [] };
  }

  const actions: CoachAction[] = [];
  for (const item of reply.output) {
    if (!isRecord(item) || item.type !== "function_call") continue;
    const action = toCoachAction(item.name, item.arguments, barCount);
    if (action !== null) actions.push(action);
  }

  return { message: messageFromOutput(reply.output) ?? DEFAULT_COACH_MESSAGE, actions };
}

const ONES: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};

const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Rewrite spoken numbers as digits before the command patterns run.
 *
 * Muse Voice Transcribe writes numbers as words, so a transcript reads "loop bars five to eight"
 * while every pattern below matches digits. Measured on the first live call: the phrase came back
 * exactly right and the command was dropped anyway, which is worse than mishearing because nothing
 * on screen says why.
 */
function digitsFromWords(text: string): string {
  let result = text;
  for (const [tens, tensValue] of Object.entries(TENS)) {
    for (const [ones, onesValue] of Object.entries(ONES)) {
      if (onesValue > 9) continue;
      result = result.replace(
        new RegExp(`\\b${tens}[\\s-]+${ones}\\b`, "g"),
        String(tensValue + onesValue),
      );
    }
    result = result.replace(new RegExp(`\\b${tens}\\b`, "g"), String(tensValue));
  }
  result = result.replace(/\bone hundred\b|\ba hundred\b|\bhundred\b/g, "100");
  for (const [word, value] of Object.entries(ONES)) {
    result = result.replace(new RegExp(`\\b${word}\\b`, "g"), String(value));
  }
  return result;
}

export function parseVoiceCoachCommand(phrase: string): CoachAction | null {
  const spoken = phrase.trim().toLowerCase();
  if (spoken.length === 0) return null;
  const lower = digitsFromWords(spoken);

  const loopMatch = lower.match(/(?:loop|bars?)\s*(\d+)\s*(?:to|-|–|and)\s*(\d+)/i);
  if (loopMatch?.[1] !== undefined && loopMatch[2] !== undefined) {
    const s = Math.max(1, parseInt(loopMatch[1], 10));
    const e = Math.max(s + 1, parseInt(loopMatch[2], 10));
    return { name: "set_loop", args: { start_bar: s, end_bar: e } };
  }

  const loopSingleMatch = lower.match(/loop\s*(?:bar)?\s*(\d+)/i);
  if (loopSingleMatch?.[1] !== undefined) {
    const bar = Math.max(1, parseInt(loopSingleMatch[1], 10));
    return {
      name: "set_loop",
      args: { start_bar: Math.max(1, bar - 1), end_bar: Math.min(16, bar + 2) },
    };
  }

  if (lower.includes("slow") || lower.includes("tempo") || lower.includes("speed")) {
    const numMatch = lower.match(/(\d{2,3})/);
    const pct =
      numMatch?.[1] !== undefined ? Math.max(40, Math.min(100, parseInt(numMatch[1], 10))) : 75;
    return { name: "set_tempo", args: { percent: pct } };
  }

  if (lower.includes("left hand") || lower.includes("left")) {
    return { name: "switch_hand", args: { hand: "left" } };
  }

  if (lower.includes("right hand") || lower.includes("right") || lower.includes("lead")) {
    return { name: "switch_hand", args: { hand: "right" } };
  }

  if (lower.includes("both hands") || lower.includes("reset hands")) {
    return { name: "switch_hand", args: { hand: "both" } };
  }

  const simplifyMatch = lower.match(/simplify\s*(?:bar)?\s*(\d+)/i);
  if (simplifyMatch?.[1] !== undefined) {
    const bar = Math.max(1, parseInt(simplifyMatch[1], 10));
    return { name: "simplify_bar", args: { bar } };
  }

  return null;
}


const COACH_ENDPOINT = "/api/coach";
export const COACH_UNREACHABLE_MESSAGE = "The Coach could not be reached. Try again.";

export type CoachPartNote = {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  bar?: number;
  hand?: HandFilter;
};

export type CoachRequestBody = {
  score: ScoreBar[];
  barCount: number;
  notes: CoachPartNote[];
};

/** Ask the Coach what to do about a take.
 *
 * The route answers `{message, actions}` and has already dropped anything that does not fit the
 * fixed tool contract, but the reply is still parsed here: a route can be redeployed ahead of the
 * page that calls it, and an action that reached the studio unchecked would move the loop or the
 * tempo to a bar that does not exist.
 */
export async function requestCoach(body: CoachRequestBody): Promise<CoachReply> {
  let response: Response;
  try {
    response = await fetch(COACH_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { message: COACH_UNREACHABLE_MESSAGE, actions: [] };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { message: INVALID_COACH_REPLY_MESSAGE, actions: [] };
  }
  return parseCoachModelReply(payload, body.barCount);
}
