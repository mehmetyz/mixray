export const STEP_IDS = ["add", "pick", "xray", "learn", "take"] as const;

export type StepId = (typeof STEP_IDS)[number];
export type ClipStepId = Exclude<StepId, "add">;

export const STEP_LABELS: Record<StepId, string> = {
  add: "Add Media",
  pick: "Isolate",
  xray: "Analyze",
  learn: "Practice",
  take: "Export",
};

export type AddNavState = {
  current: "add";
};

export type ClipNavState = {
  current: ClipStepId;
  clipId: string;
  soundPicked: boolean;
  isolationId?: string;
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

function stepHref(id: StepId, nav: NavState): string | null {
  if (id === "add") return "/studio/new";
  if (nav.current === "add") return null;
  if (id !== "pick" && !nav.soundPicked) return null;
  const base = `/c/${encodeURIComponent(nav.clipId)}/${id}`;
  if (nav.isolationId !== undefined && nav.isolationId.length > 0) {
    return `${base}?iso=${encodeURIComponent(nav.isolationId)}`;
  }
  return base;
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
