import { ClipScreen, type ClipPageProps } from "@/components/ClipScreen";

export default async function XRayPage({ params }: ClipPageProps) {
  const { id } = await params;
  return <ClipScreen clipId={id} step="xray" title="X-Ray" />;
}
