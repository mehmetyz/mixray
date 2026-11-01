import type { CoachAction } from "./coach";

export type MonitorChoice = "sound" | "rest" | "mix";
export type PracticeLevel = "easy" | "intermediate";
export type ScreenChoice = "pick" | "xray" | "learn" | "take";
export type SpokenFact = "tempo" | "key" | "bar";

export type StudioCommand =
  | { name: "play" }
  | { name: "pause" }
  | { name: "restart" }
  | { name: "seek_bar"; bar: number }
  | { name: "seek_relative"; bars: number }
  | { name: "loop_here"; bars: number }
  | { name: "loop_off" }
  | { name: "tempo_step"; delta: number }
  | { name: "monitor"; stem: MonitorChoice }
  | { name: "level"; level: PracticeLevel }
  | { name: "select_sound"; sound: string }
  | { name: "go_to"; screen: ScreenChoice }
  | { name: "octave"; delta: number }
  | { name: "tell"; fact: SpokenFact }
  | { name: "help" };

const TEMPO_STEP = 10;
const DEFAULT_LOOP_BARS = 4;
// "use both hands" and "switch to normal speed" name no sound; the Coach tools read those.
const NOT_A_SOUND = /\b(hands?|speed|tempo|percent|bars?)\b/;

const SCREENS: Record<string, ScreenChoice> = {
  isolate: "pick",
  analyze: "xray",
  analysis: "xray",
  practice: "learn",
  export: "take",
};

/** Commands for playing and moving around. Text is lowercase, with digits and no punctuation. */
export function parseStudioCommand(text: string): StudioCommand | null {
  if (/^(help|commands|what can i say)$/.test(text)) return { name: "help" };

  const fact = text.match(/^(?:what(?:'s| is)?|which)\s+(?:the\s+)?(tempo|key|bar)\b/);
  if (fact?.[1] === "tempo" || fact?.[1] === "key" || fact?.[1] === "bar") {
    return { name: "tell", fact: fact[1] };
  }

  if (/\b(from the (top|beginning|start)|start over|start again|restart|go back to the start|again)\b/.test(text)) {
    return { name: "restart" };
  }

  if (/^(loop off|stop (the )?loop(ing)?|no loop|cancel (the )?loop|end (the )?loop)$/.test(text)) {
    return { name: "loop_off" };
  }
  const loopBars = text.match(/\bloop (?:the |these |this |next )*(\d+) bars?\b/);
  if (loopBars?.[1] !== undefined) return { name: "loop_here", bars: Number(loopBars[1]) };
  if (/\bloop this bar\b/.test(text)) return { name: "loop_here", bars: 1 };
  if (/^loop( this| here| it)?$/.test(text)) return { name: "loop_here", bars: DEFAULT_LOOP_BARS };

  const seekBar = text.match(/^(?:(?:go|jump|skip) to |play from |from |start from )?bar (\d+)$/);
  if (seekBar?.[1] !== undefined) return { name: "seek_bar", bar: Number(seekBar[1]) };
  const back = text.match(/\b(?:go )?back (\d+) bars?\b/);
  if (back?.[1] !== undefined) return { name: "seek_relative", bars: -Number(back[1]) };
  const forward = text.match(/\b(?:go |skip )?(?:forward|ahead) (\d+) bars?\b/);
  if (forward?.[1] !== undefined) return { name: "seek_relative", bars: Number(forward[1]) };
  if (/^(next bar|skip ahead|go forward)$/.test(text)) return { name: "seek_relative", bars: 1 };
  if (/^(previous bar|last bar|go back)$/.test(text)) return { name: "seek_relative", bars: -1 };

  if (/^(?:go |play |a bit |a little )*(?:slower|lower|slow down|slow it down)$/.test(text)) {
    return { name: "tempo_step", delta: -TEMPO_STEP };
  }
  if (/^(?:go |play |a bit |a little )*(?:faster|speed up|speed it up)$/.test(text)) {
    return { name: "tempo_step", delta: TEMPO_STEP };
  }

  if (/\b(full mix|with the (band|mix))\b|^everything$/.test(text)) return { name: "monitor", stem: "mix" };
  if (/\b(backing( track)?( only)?|the rest|without the sound|play along)\b/.test(text)) {
    return { name: "monitor", stem: "rest" };
  }
  if (/\b((just|only) (the )?sound|sound (alone|only)|solo)\b/.test(text)) return { name: "monitor", stem: "sound" };

  const level = text.match(/^(?:switch to |go to |use |the )?(easy|intermediate)\b/);
  if (level?.[1] === "easy" || level?.[1] === "intermediate") return { name: "level", level: level[1] };

  if (/\b(octave up|up an octave)\b/.test(text)) return { name: "octave", delta: 1 };
  if (/\b(octave down|down an octave)\b/.test(text)) return { name: "octave", delta: -1 };

  const screen = text.match(/^(?:go to |open |show )(?:the )?(\w+)(?: screen| page)?$/);
  const target = screen?.[1] !== undefined ? SCREENS[screen[1]] : undefined;
  if (target !== undefined) return { name: "go_to", screen: target };

  const sound = text.match(/^(?:switch to|select|listen to|practice|change to|use) (?:the )?(.+)$/);
  if (sound?.[1] !== undefined && !NOT_A_SOUND.test(sound[1])) return { name: "select_sound", sound: sound[1] };

  if (/^(pause|stop|hold on|wait|stop playing)\b/.test(text)) return { name: "pause" };
  if (/^(play|resume|continue|go|start|start playing|let's go)$/.test(text)) return { name: "play" };

  return null;
}

/** Finds the sound a spoken name refers to, whichever of the two names is the longer one. */
export function matchSoundByName<Sound extends { label: string; prompt: string }>(
  sounds: readonly Sound[],
  spoken: string,
): Sound | undefined {
  const name = spoken.toLowerCase();
  return sounds.find((sound) => {
    const label = sound.label.toLowerCase();
    const prompt = sound.prompt.toLowerCase();
    return label === name || prompt === name || label.includes(name) || name.includes(label);
  });
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

const WAKE_WORD_PATTERN = /\b(?:mix\s*ray|mixray|mix-ray|mics\s*ray|mic\s*ray)\b/i;
const STRIP_WAKE_WORD_PATTERN =
  /^(?:hello|hey|hi|ok|okay)?\s*(?:mix\s*ray|mixray|mix-ray|mics\s*ray|mic\s*ray)[,.:;!?\s]*/i;

export function parseVoiceCoachCommand(phrase: string): CoachAction | null {
  let spoken = phrase.trim().toLowerCase();
  if (spoken.length === 0) return null;

  // Strip wake word prefix if present: "hello mixray", "hey mix ray", "mixray", "hi mix ray"
  spoken = spoken.replace(STRIP_WAKE_WORD_PATTERN, "").trim();
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

  if (/\bhalf (speed|tempo|time)\b/.test(lower)) {
    return { name: "set_tempo", args: { percent: 50 } };
  }

  if (
    lower.includes("faster") ||
    lower.includes("speed up") ||
    lower.includes("normal tempo") ||
    lower.includes("normal speed") ||
    lower.includes("full speed")
  ) {
    return { name: "set_tempo", args: { percent: 100 } };
  }

  if (lower.includes("slow") || lower.includes("slower") || lower.includes("tempo") || lower.includes("speed")) {
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

function describeStudioCommand(command: StudioCommand): string {
  switch (command.name) {
    case "play":
      return "Playing";
    case "pause":
      return "Paused";
    case "restart":
      return "From the top";
    case "seek_bar":
      return `Bar ${command.bar}`;
    case "seek_relative":
      return command.bars > 0 ? `Forward ${command.bars} bars` : `Back ${-command.bars} bars`;
    case "loop_here":
      return `Looping ${command.bars} bars from here`;
    case "loop_off":
      return "Loop off";
    case "tempo_step":
      return command.delta > 0 ? "Faster" : "Slower";
    case "monitor":
      return command.stem === "sound" ? "Solo" : command.stem === "rest" ? "The rest of the mix" : "Full mix";
    case "level":
      return command.level === "easy" ? "Easy part" : "Intermediate part";
    case "select_sound":
      return `Switching to ${command.sound}`;
    case "go_to":
      return `Opening ${command.screen}`;
    case "octave":
      return command.delta > 0 ? "Octave up" : "Octave down";
    case "tell":
      return `Reading the ${command.fact}`;
    case "help":
      return "Here is what you can say";
  }
}

export type VoiceIntent =
  | { kind: "action"; action: CoachAction; description: string }
  | { kind: "analyze"; description: string }
  | { kind: "studio"; command: StudioCommand; description: string }
  | { kind: "reset"; description: string }
  | { kind: "greeting"; description: string }
  | { kind: "unknown"; description: string };

export type ParsedVoiceMessage = {
  intent: VoiceIntent;
  wakeWordDetected: boolean;
  cleanTranscript: string;
};

export function parseVoiceAssistantMessage(phrase: string): ParsedVoiceMessage {
  // Live transcripts sometimes stutter: measured "go to bar bar five" and "loop this this bar".
  const trimmed = phrase.trim().replace(/\b(\w+)(?:[\s,]+\1\b)+/gi, "$1");
  const lower = trimmed.toLowerCase();

  const wakeWordDetected = WAKE_WORD_PATTERN.test(lower);
  const clean = lower.replace(STRIP_WAKE_WORD_PATTERN, "").trim();

  // If user only said greeting / wake word with no follow-up command
  if (wakeWordDetected && clean.length === 0) {
    return {
      intent: {
        kind: "greeting",
        description: "Listening. Say 'loop 4 to 8', 'slower' or 'how did I do'.",
      },
      wakeWordDetected: true,
      cleanTranscript: trimmed,
    };
  }

  const command = parseStudioCommand(digitsFromWords(clean.replace(/[.,!?;:]|\bplease\b/g, "").trim()));
  if (command !== null) {
    return {
      intent: { kind: "studio", command, description: describeStudioCommand(command) },
      wakeWordDetected,
      cleanTranscript: clean,
    };
  }

  if (
    clean.includes("analyze") ||
    clean.includes("how did i do") ||
    clean.includes("review") ||
    clean.includes("feedback") ||
    clean.includes("how was that")
  ) {
    return {
      intent: { kind: "analyze", description: "Analyzing your practice take..." },
      wakeWordDetected,
      cleanTranscript: clean,
    };
  }

  if (clean.includes("reset") || clean.includes("clear")) {
    return {
      intent: { kind: "reset", description: "Resetting loop and tempo" },
      wakeWordDetected,
      cleanTranscript: clean,
    };
  }

  const action = parseVoiceCoachCommand(trimmed);
  if (action !== null) {
    let desc = "Applied command";
    if (action.name === "set_loop") {
      desc = `Looped bars ${action.args.start_bar}–${action.args.end_bar}`;
    } else if (action.name === "set_tempo") {
      desc = `Tempo set to ${action.args.percent}%`;
    } else if (action.name === "switch_hand") {
      desc = `Hand set to ${action.args.hand}`;
    } else if (action.name === "simplify_bar") {
      desc = `Simplified bar ${action.args.bar}`;
    } else if (action.name === "mark_problem_bar") {
      desc = `Marked bar ${action.args.bar}`;
    }
    return {
      intent: { kind: "action", action, description: desc },
      wakeWordDetected,
      cleanTranscript: clean,
    };
  }

  return {
    intent: {
      kind: "unknown",
      description: wakeWordDetected
        ? `Heard "${clean}", try "slow down", "play", or "loop bar 4 to 8".`
        : "Not a command. Try: loop 4 to 8, slower, play.",
    },
    wakeWordDetected,
    cleanTranscript: clean,
  };
}

export const VOICE_COMMAND_HELP: readonly { topic: string; examples: string }[] = [
  { topic: "Play", examples: "play, pause, from the top, again" },
  { topic: "Move", examples: "bar 5, back 2 bars, next bar" },
  { topic: "Loop", examples: "loop 4 to 8, loop 2 bars, loop off" },
  { topic: "Tempo", examples: "slower, faster, slow to 70 percent, normal speed" },
  { topic: "Hear", examples: "solo, the rest, full mix, switch to bass" },
  { topic: "Part", examples: "easy, intermediate, left hand, both hands, octave up" },
  { topic: "Coach", examples: "how did I do, simplify bar 6" },
  { topic: "Ask", examples: "what is the key, what is the tempo, which bar" },
];
