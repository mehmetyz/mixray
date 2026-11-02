"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ClipPicker } from "@/components/ClipPicker";
import { ProjectDashboard } from "@/components/ProjectDashboard";
import { AddShell } from "@/components/StudioShell";
import { useProjects } from "@/lib/projects/storage";

function HomeContent() {
  const searchParams = useSearchParams();
  const projects = useProjects();
  const [isAdding, setIsAdding] = useState<boolean>(
    searchParams.get("add") === "1" || searchParams.get("new") === "1",
  );

  // Someone with no clips yet has nothing to choose from, so they start on Add.
  if (isAdding || projects.length === 0) {
    return (
      <AddShell className="max-w-3xl">
        <ClipPicker onCancel={projects.length > 0 ? () => setIsAdding(false) : undefined} />
      </AddShell>
    );
  }

  return (
    <AddShell className="max-w-3xl">
      <ProjectDashboard projects={projects} onAddNew={() => setIsAdding(true)} />
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
