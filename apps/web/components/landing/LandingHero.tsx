"use client";

import { useEffect, useState, type ReactNode } from "react";
import { CafeStage, type StageStep } from "./CafeStage";

type LandingHeroProps = {
  children: ReactNode;
};

const FINAL_STEP: StageStep = 3;
const LINES: readonly { text: string; step: StageStep }[] = [
  { text: "Point at a sound.", step: 1 },
  { text: "Hear it alone.", step: 2 },
  { text: "Learn to play it.", step: 3 },
];
const STEP_TIMES_MS: readonly { step: StageStep; at: number }[] = [
  { step: 1, at: 500 },
  { step: 2, at: 1900 },
  { step: 3, at: 3300 },
];

/** One sequence on load: each line of the promise lights as the clip below does that very thing. */
export function LandingHero({ children }: LandingHeroProps) {
  const [step, setStep] = useState<StageStep>(0);

  useEffect(() => {
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers = still
      ? [window.setTimeout(() => setStep(FINAL_STEP), 0)]
      : STEP_TIMES_MS.map(({ step: next, at }) =>
          window.setTimeout(() => setStep((current) => (next > current ? next : current)), at),
        );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, []);

  return (
    <section className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:gap-16">
      <div className="lg:pt-10">
        <h1 className="text-5xl font-semibold leading-[1.04] tracking-[-0.035em] sm:text-6xl xl:text-7xl">
          {LINES.map((line) => (
            <span
              key={line.text}
              className={`block transition-colors duration-500 motion-reduce:transition-none ${
                step >= line.step ? "text-text" : "text-inactive"
              }`}
            >
              {line.text}
            </span>
          ))}
        </h1>
        <p className="mt-6 max-w-[34rem] text-lg leading-relaxed text-text-2">
          Draw over the instrument in a video or type its name. Mixray takes that sound out of the mix, reads its notes
          and turns them into a part you can practice on a keyboard.
        </p>
        <div className="mt-8">{children}</div>
      </div>
      <CafeStage step={step} onReveal={() => setStep(FINAL_STEP)} />
    </section>
  );
}
