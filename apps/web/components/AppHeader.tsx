import Link from "next/link";
import type { NavState } from "@/lib/steps";
import { StepNav } from "./StepNav";

type AppHeaderProps = {
  nav: NavState;
};

export function AppHeader({ nav }: AppHeaderProps) {
  return (
    <header className="border-b border-line">
      <div className="page-container flex flex-wrap items-center justify-between gap-x-6 gap-y-3 py-4">
        <Link href="/" className="text-[26px] font-extrabold lowercase tracking-tight">
          mi<span className="text-accent">x</span>ray
        </Link>
        <StepNav nav={nav} />
        <p className="font-mono text-xs text-muted">Powered by Meta SAM + Muse</p>
      </div>
    </header>
  );
}
