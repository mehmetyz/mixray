import type { ReactNode } from "react";
import type { ClipRouteParams } from "@/components/ClipScreen";
import { DEMO_CLIP_IDS } from "@/lib/trackmap/load";

export const dynamicParams = false;

export function generateStaticParams(): ClipRouteParams[] {
  return DEMO_CLIP_IDS.map((id) => ({ id }));
}

type ClipLayoutProps = {
  children: ReactNode;
};

export default function ClipLayout({ children }: ClipLayoutProps) {
  return children;
}
