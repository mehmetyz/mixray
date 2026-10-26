import { ClipScreen, type ClipPageProps } from "@/components/ClipScreen";

export default async function LearnPage({ params }: ClipPageProps) {
  const { id } = await params;
  return <ClipScreen clipId={id} step="learn" title="Learn it on your keyboard" />;
}
