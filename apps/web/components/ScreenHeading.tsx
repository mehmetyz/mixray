import type { ReactNode } from "react";
import { stepEyebrow, type StepId } from "@/lib/steps";

type ScreenHeadingProps = {
  step: StepId;
  title: string;
  children?: ReactNode;
};

export function ScreenHeading({ step, title, children }: ScreenHeadingProps) {
  return (
    <div>
      <p className="eyebrow mb-1.5">{stepEyebrow(step)}</p>
      <h1 className="text-xl font-semibold tracking-tight text-text md:text-2xl">{title}</h1>
      {children !== undefined ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}
