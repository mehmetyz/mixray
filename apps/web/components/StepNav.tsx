import Link from "next/link";
import { buildStepLinks, type NavState, type StepLink } from "@/lib/steps";

const PILL = "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full px-4 text-sm font-semibold";

type StepPillProps = {
  step: StepLink;
};

function StepPill({ step }: StepPillProps) {
  const content = (
    <>
      <span className="font-mono text-xs">{step.number}</span>
      {step.label}
    </>
  );

  if (step.isCurrent) {
    return (
      <span aria-current="page" className={`${PILL} bg-surface-2 text-text`}>
        {content}
      </span>
    );
  }

  if (step.href === null) {
    return (
      <span aria-disabled="true" className={`${PILL} cursor-not-allowed text-muted opacity-50`}>
        {content}
      </span>
    );
  }

  return (
    <Link href={step.href} className={`${PILL} text-muted hover:text-text`}>
      {content}
    </Link>
  );
}

type StepNavProps = {
  nav: NavState;
};

export function StepNav({ nav }: StepNavProps) {
  return (
    <nav aria-label="Steps" className="-mx-1 overflow-x-auto">
      <ol className="flex gap-1 px-1">
        {buildStepLinks(nav).map((step) => (
          <li key={step.id}>
            <StepPill step={step} />
          </li>
        ))}
      </ol>
    </nav>
  );
}
