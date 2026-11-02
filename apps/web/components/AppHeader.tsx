import Link from "next/link";
import type { NavState } from "@/lib/steps";
import { MixrayLogo } from "./MixrayLogo";
import { StepNav } from "./StepNav";
import { ThemeToggle } from "./ThemeToggle";

type AppHeaderProps = {
  nav: NavState;
};

export function AppHeader({ nav }: AppHeaderProps) {
  const isClipView = nav.current !== "add";

  return (
    <header className="flex h-16 shrink-0 items-center justify-between gap-6 border-b border-line bg-surface/90 px-6 backdrop-blur-md sm:px-8">
      <div className="flex min-w-0 items-center gap-4">
        <Link
          href="/"
          className="flex shrink-0 items-center transition hover:opacity-85"
          aria-label="Mixray Home"
        >
          <MixrayLogo size="md" />
        </Link>
        {isClipView ? (
          <Link
            href="/"
            className="hidden sm:inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-text transition border-l border-line pl-4"
          >
            All clips
          </Link>
        ) : null}
      </div>

      {isClipView ? (
        <div className="hidden sm:flex items-center justify-center">
          <StepNav nav={nav} variant="header" />
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        {isClipView ? <StepNav nav={nav} variant="mobile" /> : null}
        <ThemeToggle />
      </div>
    </header>
  );
}
