export const STEP_IDS = ["add", "pick", "xray", "learn", "take"] as const;

export type StepId = (typeof STEP_IDS)[number];
export type ClipStepId = Exclude<StepId, "add">;

export const STEP_LABELS: Record<StepId, string> = {
  add: "Add",
  pick: "Pick",
  xray: "X-Ray",
  learn: "Learn",
  take: "Take home",
};

const STEP_EYEBROWS: Record<StepId, string> = {
  add: "Add",
  pick: "Pick a sound",
  xray: "X-Ray",
  learn: "Learn",
  take: "Take home",
};

export type AddNavState = {
  current: "add";
};

export type ClipNavState = {
  current: ClipStepId;
  clipId: string;
  soundPicked: boolean;
};

/** Where the user is in the flow; clip steps exist only once a clip is added. */
export type NavState = AddNavState | ClipNavState;

export type StepLink = {
  id: StepId;
  number: number;
  label: string;
  href: string | null;
  isCurrent: boolean;
};

export function stepNumber(id: StepId): number {
  return STEP_IDS.indexOf(id) + 1;
}

export function stepEyebrow(id: StepId): string {
  return `Step ${stepNumber(id)} · ${STEP_EYEBROWS[id]}`;
}

function stepHref(id: StepId, nav: NavState): string | null {
  if (id === "add") return "/";
  if (nav.current === "add") return null;
  if (id !== "pick" && !nav.soundPicked) return null;
  return `/c/${nav.clipId}/${id}`;
}

export function buildStepLinks(nav: NavState): StepLink[] {
  return STEP_IDS.map((id) => ({
    id,
    number: stepNumber(id),
    label: STEP_LABELS[id],
    href: stepHref(id, nav),
    isCurrent: id === nav.current,
  }));
}
