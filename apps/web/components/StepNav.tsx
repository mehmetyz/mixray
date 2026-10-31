import Link from "next/link";
import { buildStepLinks, type NavState, type StepId, type StepLink } from "@/lib/steps";

type StepNavProps = {
  nav: NavState;
  variant?: "sidebar" | "mobile" | "header";
};

type StepRowProps = {
  step: StepLink;
  variant: "sidebar" | "mobile" | "header";
};

function StepIcon({ id, className }: { id: StepId; className?: string }) {
  switch (id) {
    case "add":
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={className}
          aria-hidden="true"
        >
          <path d="M8 3v10M3 8h10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case "pick":
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={className}
          aria-hidden="true"
        >
          <path
            d="M2 8h1.5M5 4.5v7M8 2v12M11 5v6M14 8h-1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "xray":
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={className}
          aria-hidden="true"
        >
          <path
            d="M2 8.5h2.5l2-4.5 3 8 2-4.5h2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "learn":
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={className}
          aria-hidden="true"
        >
          <rect x="2" y="3" width="12" height="10" rx="1.5" strokeLinecap="round" />
          <path d="M5 3v5M8 3v5M11 3v5" strokeLinecap="round" />
        </svg>
      );
    case "take":
      return (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={className}
          aria-hidden="true"
        >
          <path d="M8 2.5v7.5M5.5 7.5L8 10l2.5-2.5M3 13.5h10" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
  }
}

function StepRow({ step, variant }: StepRowProps) {
  if (variant === "header") {
    if (step.id === "add") return null;

    const base =
      "px-4 py-1.5 rounded-full text-xs font-semibold tracking-normal transition inline-flex items-center gap-2 select-none";
    if (step.isCurrent) {
      return (
        <span aria-current="page" className={`${base} bg-text text-bg shadow-sm`}>
          <StepIcon id={step.id} className="h-3.5 w-3.5 text-accent" />
          <span>{step.label}</span>
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
      );
    }
    if (step.href === null) {
      return (
        <span aria-disabled="true" className={`${base} cursor-not-allowed text-muted/35`}>
          <StepIcon id={step.id} className="h-3.5 w-3.5 opacity-40" />
          <span>{step.label}</span>
        </span>
      );
    }
    return (
      <Link href={step.href} className={`${base} text-text-2 hover:bg-surface-2 hover:text-text`}>
        <StepIcon id={step.id} className="h-3.5 w-3.5 opacity-75" />
        <span>{step.label}</span>
      </Link>
    );
  }

  if (variant === "mobile") {
    const base =
      "px-3 py-1.5 rounded-full text-xs font-semibold shrink-0 transition inline-flex items-center gap-1.5 select-none";
    if (step.isCurrent) {
      return (
        <span aria-current="page" className={`${base} bg-text text-bg shadow-sm`}>
          <StepIcon id={step.id} className="h-3 w-3 text-accent" />
          <span>{step.label}</span>
        </span>
      );
    }
    if (step.href === null) {
      return (
        <span aria-disabled="true" className={`${base} cursor-not-allowed text-muted/35`}>
          <StepIcon id={step.id} className="h-3 w-3 opacity-40" />
          <span>{step.label}</span>
        </span>
      );
    }
    return (
      <Link href={step.href} className={`${base} text-muted hover:text-text`}>
        <StepIcon id={step.id} className="h-3 w-3 opacity-75" />
        <span>{step.label}</span>
      </Link>
    );
  }

  const rowBase =
    "w-full flex items-center justify-between px-3.5 py-2.5 rounded-card text-xs font-medium transition select-none";
  const inner = (
    <>
      <span className="flex items-center gap-2.5">
        <StepIcon id={step.id} className={`h-4 w-4 ${step.isCurrent ? "text-accent" : "text-muted"}`} />
        <span>{step.label}</span>
      </span>
      {step.isCurrent ? <span className="h-2 w-2 rounded-full bg-accent shadow-sm shadow-accent/50" /> : null}
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
      <span aria-disabled="true" className={`${rowBase} cursor-not-allowed text-muted/35`}>
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
      <nav
        aria-label="Studio workspaces"
        className="hidden sm:flex items-center gap-1.5 rounded-full border border-line-2 bg-inset/80 p-1.5 shadow-sm backdrop-blur-md"
      >
        {steps.map((step) => (
          <StepRow key={step.id} step={step} variant="header" />
        ))}
      </nav>
    );
  }

  if (variant === "mobile") {
    return (
      <nav aria-label="Workspaces" className="flex items-center gap-1.5 overflow-x-auto sm:hidden">
        {steps.map((step) => (
          <StepRow key={step.id} step={step} variant="mobile" />
        ))}
      </nav>
    );
  }

  return (
    <nav aria-label="Studio workspaces">
      <p className="mb-2.5 px-3 text-xs font-semibold tracking-wider text-muted uppercase">Workspace</p>
      <ol className="space-y-1.5">
        {steps.map((step) => (
          <li key={step.id}>
            <StepRow step={step} variant="sidebar" />
          </li>
        ))}
      </ol>
    </nav>
  );
}
