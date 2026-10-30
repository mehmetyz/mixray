import { parseCoachModelReply } from "@/lib/coach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const META_RESPONSES_URL = "https://api.meta.ai/v1/responses";
const MUSE_SPARK_MODEL = "muse-spark-1.2-contributor";
const MAX_BAR_COUNT = 128;
const MAX_NOTES = 4096;

type JsonRecord = Record<string, unknown>;

type CoachScoreBar = {
  index: number;
  startSeconds: number;
  endSeconds: number;
  attempted: boolean;
  hitRate: number;
  onTimeRate: number;
  meanOffsetMs: number | null;
  missed: number;
  extra: number;
  wrongPitch: number;
};

type CoachPartNote = {
  start: number;
  end: number;
  pitch: number;
  velocity: number;
  bar?: number;
  hand?: "right" | "left";
};

type CoachRequest = {
  score: CoachScoreBar[];
  barCount: number;
  notes: CoachPartNote[];
};

type CoachError = {
  message: string;
  actions: [];
};

const COACH_TOOLS = [
  {
    type: "function",
    name: "set_loop",
    description: "Loop an inclusive range of bars that needs focused practice.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["start_bar", "end_bar"],
      properties: {
        start_bar: { type: "integer" },
        end_bar: { type: "integer" },
      },
    },
    strict: true,
  },
  {
    type: "function",
    name: "set_tempo",
    description: "Set the practice tempo as a percentage of the original tempo.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["percent"],
      properties: { percent: { type: "integer", minimum: 40, maximum: 100 } },
    },
    strict: true,
  },
  {
    type: "function",
    name: "switch_hand",
    description: "Choose the hand or hands to practice.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["hand"],
      properties: { hand: { type: "string", enum: ["right", "left", "both"] } },
    },
    strict: true,
  },
  {
    type: "function",
    name: "simplify_bar",
    description: "Simplify one difficult bar for practice.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["bar"],
      properties: { bar: { type: "integer" } },
    },
    strict: true,
  },
  {
    type: "function",
    name: "mark_problem_bar",
    description: "Highlight one bar and give a concise reason it needs practice.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["bar", "reason"],
      properties: {
        bar: { type: "integer" },
        reason: { type: "string" },
      },
    },
    strict: true,
  },
] as const;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return isInteger(value) && value >= 0;
}

function parseScoreBar(value: unknown, barCount: number): CoachScoreBar | null {
  if (!isRecord(value)) return null;
  const {
    index,
    startSeconds,
    endSeconds,
    attempted,
    hitRate,
    onTimeRate,
    meanOffsetMs,
    missed,
    extra,
    wrongPitch,
  } = value;
  if (
    !isInteger(index) ||
    index < 0 ||
    index >= barCount ||
    !isFiniteNumber(startSeconds) ||
    !isFiniteNumber(endSeconds) ||
    endSeconds < startSeconds ||
    typeof attempted !== "boolean" ||
    !isFiniteNumber(hitRate) ||
    hitRate < 0 ||
    hitRate > 1 ||
    !isFiniteNumber(onTimeRate) ||
    onTimeRate < 0 ||
    onTimeRate > 1 ||
    (meanOffsetMs !== null && !isFiniteNumber(meanOffsetMs)) ||
    !isNonNegativeInteger(missed) ||
    !isNonNegativeInteger(extra) ||
    !isNonNegativeInteger(wrongPitch)
  ) {
    return null;
  }
  return {
    index,
    startSeconds,
    endSeconds,
    attempted,
    hitRate,
    onTimeRate,
    meanOffsetMs,
    missed,
    extra,
    wrongPitch,
  };
}

function parsePartNote(value: unknown, barCount: number): CoachPartNote | null {
  if (!isRecord(value)) return null;
  const { start, end, pitch, velocity, bar, hand } = value;
  if (
    !isFiniteNumber(start) ||
    start < 0 ||
    !isFiniteNumber(end) ||
    end < start ||
    !isInteger(pitch) ||
    pitch < 0 ||
    pitch > 127 ||
    !isFiniteNumber(velocity) ||
    velocity < 0 ||
    velocity > 1 ||
    (bar !== undefined && (!isInteger(bar) || bar < 1 || bar > barCount)) ||
    (hand !== undefined && hand !== "right" && hand !== "left")
  ) {
    return null;
  }

  const note: CoachPartNote = { start, end, pitch, velocity };
  if (bar !== undefined) note.bar = bar;
  if (hand !== undefined) note.hand = hand;
  return note;
}

function parseCoachRequest(value: unknown): CoachRequest | null {
  if (!isRecord(value) || !isInteger(value.barCount) || value.barCount < 1 || value.barCount > MAX_BAR_COUNT) {
    return null;
  }
  if (!Array.isArray(value.score) || value.score.length !== value.barCount || !Array.isArray(value.notes)) {
    return null;
  }
  if (value.notes.length > MAX_NOTES) return null;

  const score: CoachScoreBar[] = [];
  const scoreIndexes = new Set<number>();
  for (const bar of value.score) {
    const parsed = parseScoreBar(bar, value.barCount);
    if (parsed === null || scoreIndexes.has(parsed.index)) return null;
    scoreIndexes.add(parsed.index);
    score.push(parsed);
  }
  if (scoreIndexes.size !== value.barCount) return null;

  const notes: CoachPartNote[] = [];
  for (const note of value.notes) {
    const parsed = parsePartNote(note, value.barCount);
    if (parsed === null) return null;
    notes.push(parsed);
  }
  return { score, barCount: value.barCount, notes };
}

function errorResponse(message: string, status: number): Response {
  const body: CoachError = { message, actions: [] };
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function coachInstructions(): string {
  return [
    "You are Mixray's concise piano practice coach.",
    "Use only the supplied per-bar score and part notes; never invent scoring data.",
    "Give one short, practical message. Use the provided tools only when an adjustment helps.",
    "Bar numbers in tools are one-based and must be within the supplied bar count.",
  ].join(" ");
}

function coachInput(request: CoachRequest): string {
  return JSON.stringify({
    bar_count: request.barCount,
    per_bar_score: request.score,
    part_notes: request.notes,
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Send a valid Coach request.", 400);
  }

  const coachRequest = parseCoachRequest(body);
  if (coachRequest === null) {
    return errorResponse("Send valid score, bar count, and part notes.", 400);
  }

  const apiKey = process.env.META_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return errorResponse("The Coach service is not configured.", 503);
  }

  let upstream: Response;
  try {
    // Muse Spark drops input_audio; the browser's computed score and notes are the reliable source.
    upstream = await fetch(META_RESPONSES_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MUSE_SPARK_MODEL,
        instructions: coachInstructions(),
        input: [
          {
            role: "user",
            content: [{ type: "input_text", text: coachInput(coachRequest) }],
          },
        ],
        tools: COACH_TOOLS,
        tool_choice: "auto",
        max_output_tokens: 4000,
        store: false,
      }),
    });
  } catch {
    return errorResponse("The Coach service is unavailable. Try again.", 502);
  }

  if (!upstream.ok) {
    return errorResponse("The Coach service is unavailable. Try again.", 502);
  }

  let modelReply: unknown;
  try {
    modelReply = await upstream.json();
  } catch {
    return errorResponse("The Coach reply could not be read. Try again.", 502);
  }

  const reply = parseCoachModelReply(modelReply, coachRequest.barCount);

  return Response.json(reply, { headers: { "cache-control": "no-store" } });
}
