import Link from "next/link";
import type { NavState } from "@/lib/steps";
import { StepNav } from "./StepNav";

type AppHeaderProps = {
  nav: NavState;
  clipMeta?: string;
};

export function AppHeader({ nav, clipMeta }: AppHeaderProps) {
  return (
    <header className="flex h-11 shrink-0 items-center justify-between gap-4 border-b border-line bg-surface px-4">
      <div className="flex min-w-0 items-center gap-4">
        <Link
          href="/"
          className="flex shrink-0 items-center gap-2 text-sm font-bold lowercase tracking-tight text-text"
        >
          <span>
            mi<span className="text-accent">x</span>ray
          </span>
        </Link>
        {clipMeta !== undefined ? (
          <div className="hidden min-w-0 items-center gap-2 border-l border-line pl-3 text-xs text-text-2 md:flex">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
            <span className="mono-num truncate">{clipMeta}</span>
          </div>
        ) : null}
      </div>

      <StepNav nav={nav} variant="mobile" />
    </header>
  );
}
