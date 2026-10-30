import Link from "next/link";
import { buildStepLinks, type NavState, type StepLink } from "@/lib/steps";

type StepNavProps = {
  nav: NavState;
  variant?: "sidebar" | "mobile" | "header";
};

type StepRowProps = {
  step: StepLink;
  variant: "sidebar" | "mobile" | "header";
};

function StepRow({ step, variant }: StepRowProps) {
  if (variant === "header") {
    if (step.id === "add") return null;

    const base =
      "px-3.5 py-1 rounded-full text-xs sm:text-sm font-medium transition inline-flex items-center gap-1.5";
    if (step.isCurrent) {
      return (
        <span aria-current="page" className={`${base} bg-text font-semibold text-bg shadow-xs`}>
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {step.label}
        </span>
      );
    }
    if (step.href === null) {
      return (
        <span aria-disabled="true" className={`${base} cursor-not-allowed text-muted/40`}>
          {step.label}
        </span>
      );
    }
    return (
      <Link href={step.href} className={`${base} text-text-2 hover:bg-surface-2 hover:text-text`}>
        {step.label}
      </Link>
    );
  }

  if (variant === "mobile") {
    const base = "px-2.5 py-1 rounded-full text-xs font-medium shrink-0 transition inline-flex items-center gap-1";
    if (step.isCurrent) {
      return (
        <span aria-current="page" className={`${base} bg-text font-semibold text-bg shadow-xs`}>
          {step.label}
        </span>
      );
    }
    if (step.href === null) {
      return (
        <span aria-disabled="true" className={`${base} cursor-not-allowed text-muted/40`}>
          {step.label}
        </span>
      );
    }
    return (
      <Link href={step.href} className={`${base} text-muted hover:text-text`}>
        {step.label}
      </Link>
    );
  }

  const rowBase =
    "w-full flex items-center justify-between px-3 py-2 rounded-card text-sm font-medium transition";
  const inner = (
    <>
      <span className="flex items-center gap-2">
        <span>{step.label}</span>
      </span>
      {step.isCurrent ? <span className="h-2 w-2 rounded-full bg-accent shadow-xs shadow-accent/40" /> : null}
    </>
  );

  if (step.isCurrent) {
    return (
      <span aria-current="page" className={`${rowBase} bg-surface-2 font-semibold text-text shadow-xs`}>
        {inner}
      </span>
    );
  }
  if (step.href === null) {
    return (
      <span aria-disabled="true" className={`${rowBase} cursor-not-allowed text-muted/40`}>
        {inner}
      </span>
    );
  }
  return (
    <Link href={step.href} className={`${rowBase} text-text-2 hover:bg-surface-2/60 hover:text-text`}>
      {inner}
    </Link>
  );
}

export function StepNav({ nav, variant = "sidebar" }: StepNavProps) {
  const steps = buildStepLinks(nav);

  if (variant === "header") {
    return (
      <nav aria-label="Studio workspaces" className="hidden sm:flex items-center gap-0.5 rounded-full border border-line-2 bg-surface-2/60 p-1 shadow-xs">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} variant="header" />
        ))}
      </nav>
    );
  }

  if (variant === "mobile") {
    return (
      <nav aria-label="Workspaces" className="flex items-center gap-1 overflow-x-auto sm:hidden">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} variant="mobile" />
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Studio workspaces">
      <p className="mb-2 px-3 text-xs font-semibold tracking-wider text-muted uppercase">Workspace</p>
      <ol className="space-y-1">
        {steps.map((step) => (
          <li key={step.id}>
            <StepRow step={step} variant="sidebar" />
          </li>
        ))}
      </ol>
    </nav>
  );
}
