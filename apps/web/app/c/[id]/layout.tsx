import { ClipScreen, type ClipLayoutProps, type ClipRouteParams } from "@/components/ClipScreen";
import { DEMO_CLIP_IDS } from "@/lib/trackmap/load";

export function generateStaticParams(): ClipRouteParams[] {
  return DEMO_CLIP_IDS.map((id) => ({ id }));
}

export default function ClipLayout({ params, children }: ClipLayoutProps) {
  return <ClipScreen params={params}>{children}</ClipScreen>;
}
