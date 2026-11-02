"use client";

import { Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ClipPicker } from "@/components/ClipPicker";
import { AddShell } from "@/components/StudioShell";
import { findDemoClip } from "@/lib/demos";

function NewClipContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `/studio/new?demo=cafe-piano` opens a demo straight from a link.
  const demo = findDemoClip(searchParams.get("demo") ?? undefined);

  return <ClipPicker key={demo?.id} demo={demo} onCancel={() => router.push("/studio")} />;
}

export default function NewClipPage() {
  return (
    <AddShell className="max-w-3xl">
      <Suspense fallback={null}>
        <NewClipContent />
      </Suspense>
    </AddShell>
  );
}
