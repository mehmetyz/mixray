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
      <div className="flex min-w-0 items-center">
        <Link
          href="/"
          className="flex shrink-0 items-center transition hover:opacity-85"
          aria-label="Mixray Home"
        >
          <MixrayLogo size="md" />
        </Link>
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
