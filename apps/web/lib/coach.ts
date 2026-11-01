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
