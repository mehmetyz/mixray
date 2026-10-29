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

export function parseVoiceCoachCommand(phrase: string): CoachAction | null {
  const lower = phrase.trim().toLowerCase();
  if (lower.length === 0) return null;

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

