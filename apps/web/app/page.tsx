"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ClipPicker } from "@/components/ClipPicker";
import { ProjectDashboard } from "@/components/ProjectDashboard";
import { AddShell } from "@/components/StudioShell";
import { findDemoClip, type DemoClip } from "@/lib/demos";
import { useProjects } from "@/lib/projects/storage";

function HomeContent() {
  const searchParams = useSearchParams();
  const projects = useProjects();
  const [isAdding, setIsAdding] = useState<boolean>(
    searchParams.get("add") === "1" || searchParams.get("new") === "1",
  );
  // `/?demo=cafe-piano` opens a demo straight from a link.
  const [demo, setDemo] = useState<DemoClip | undefined>(() =>
    findDemoClip(searchParams.get("demo") ?? undefined),
  );

  if (isAdding || demo !== undefined) {
    return (
      <AddShell className="max-w-3xl">
        <ClipPicker
          demo={demo}
          onCancel={() => {
            setIsAdding(false);
            setDemo(undefined);
          }}
        />
      </AddShell>
    );
  }

  return (
    <AddShell className="max-w-5xl">
      <ProjectDashboard projects={projects} onAddNew={() => setIsAdding(true)} onOpenDemo={setDemo} />
    </AddShell>
  );
}

export default function HomePage() {
  return (
    <Suspense fallback={<AddShell className="max-w-3xl">{null}</AddShell>}>
      <HomeContent />
    </Suspense>
  );
}
