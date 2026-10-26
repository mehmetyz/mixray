import { ClipScreen, type ClipPageProps } from "@/components/ClipScreen";

export default async function PickPage({ params }: ClipPageProps) {
  const { id } = await params;
  return <ClipScreen clipId={id} step="pick" title="What do you want to hear?" />;
}
