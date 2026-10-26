import { ClipScreen, type ClipPageProps } from "@/components/ClipScreen";

export default async function TakeHomePage({ params }: ClipPageProps) {
  const { id } = await params;
  return <ClipScreen clipId={id} step="take" title="Rebuild it in your DAW." />;
}
