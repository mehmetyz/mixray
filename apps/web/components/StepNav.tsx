import Link from "next/link";
import { buildStepLinks, type NavState, type StepLink } from "@/lib/steps";

type StepNavProps = {
  nav: NavState;
  variant?: "sidebar" | "mobile";
};

type StepRowProps = {
  step: StepLink;
  compact: boolean;
};

function StepRow({ step, compact }: StepRowProps) {
  const num = String(step.number).padStart(2, "0");

  if (compact) {
    const base = "px-2.5 py-1 rounded-icon text-xs mono-num shrink-0 border transition";
    if (step.isCurrent) {
      return (
        <span aria-current="page" className={`${base} border-line-2 bg-text font-semibold text-bg`}>
          {num} {step.label}
        </span>
      );
    }
    if (step.href === null) {
      return (
        <span
          aria-disabled="true"
          className={`${base} cursor-not-allowed border-transparent text-muted opacity-45`}
        >
          {num} {step.label}
        </span>
      );
    }
    return (
      <Link href={step.href} className={`${base} border-transparent text-muted hover:text-text`}>
        {num} {step.label}
      </Link>
    );
  }

  const rowBase =
    "w-full flex items-center justify-between px-2.5 py-2 rounded-icon text-xs transition border";
  const inner = (
    <>
      <span className="flex items-center gap-2.5">
        <span className="mono-num text-muted">{num}</span>
        <span>{step.label}</span>
      </span>
      {step.isCurrent ? <span className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
    </>
  );

  if (step.isCurrent) {
    return (
      <span aria-current="page" className={`${rowBase} border-line-2 bg-surface-2 font-medium text-text`}>
        {inner}
      </span>
    );
  }
  if (step.href === null) {
    return (
      <span
        aria-disabled="true"
        className={`${rowBase} cursor-not-allowed border-transparent text-muted opacity-45`}
      >
        {inner}
      </span>
    );
  }
  return (
    <Link
      href={step.href}
      className={`${rowBase} border-transparent text-text-2 hover:bg-surface-2 hover:text-text`}
    >
      {inner}
    </Link>
  );
}

export function StepNav({ nav, variant = "sidebar" }: StepNavProps) {
  const steps = buildStepLinks(nav);

  if (variant === "mobile") {
    return (
      <nav aria-label="Steps" className="flex items-center gap-1 overflow-x-auto lg:hidden">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} compact />
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Workflow steps">
      <ol className="space-y-0.5">
        {steps.map((step) => (
          <li key={step.id}>
            <StepRow step={step} compact={false} />
          </li>
        ))}
      </ol>
    </nav>
  );
}
