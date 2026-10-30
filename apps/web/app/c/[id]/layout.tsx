import { ClipScreen, type ClipLayoutProps } from "@/components/ClipScreen";

export const dynamic = "force-dynamic";

export default function ClipLayout({ params, children }: ClipLayoutProps) {
  return <ClipScreen params={params}>{children}</ClipScreen>;
}
