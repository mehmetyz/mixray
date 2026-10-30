import Link from "next/link";
import type { NavState } from "@/lib/steps";
import { StepNav } from "./StepNav";
import { ThemeToggle } from "./ThemeToggle";

type AppHeaderProps = {
  nav: NavState;
};

export function AppHeader({ nav }: AppHeaderProps) {
  const isClipView = nav.current !== "add";

  return (
    <header className="flex h-13 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface/90 px-4 backdrop-blur-md">
      <div className="flex min-w-0 items-center">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-1.5 text-base font-bold lowercase tracking-tight text-text transition hover:opacity-85"
        >
          <span>
            mi<span className="text-accent">x</span>ray
          </span>
        </Link>
      </div>

      {isClipView ? (
        <div className="hidden sm:flex items-center justify-center">
          <StepNav nav={nav} variant="header" />
        </div>
      ) : null}

      <div className="flex items-center gap-2.5">
        {isClipView ? <StepNav nav={nav} variant="mobile" /> : null}
        <ThemeToggle />
      </div>
    </header>
  );
}
