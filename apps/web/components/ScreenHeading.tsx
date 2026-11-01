import type { ReactNode } from "react";

type ScreenHeadingProps = {
  title: string;
  children?: ReactNode;
};

export function ScreenHeading({ title, children }: ScreenHeadingProps) {
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-text">{title}</h1>
      {children !== undefined ? <div className="mt-1.5">{children}</div> : null}
    </div>
  );
}
