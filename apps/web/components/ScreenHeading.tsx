import type { ReactNode } from "react";
import { stepEyebrow, type StepId } from "@/lib/steps";

type ScreenHeadingProps = {
  step: StepId;
  title: string;
  children?: ReactNode;
};

export function ScreenHeading({ step, title, children }: ScreenHeadingProps) {
  return (
    <div className="flex flex-col gap-3">
      <p className="eyebrow">{stepEyebrow(step)}</p>
      <h1 className="text-[44px] leading-tight font-extrabold tracking-[-1.5px]">{title}</h1>
      {children}
    </div>
  );
}
