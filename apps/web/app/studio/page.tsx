"use client";

import { ProjectDashboard } from "@/components/ProjectDashboard";
import { AddShell } from "@/components/StudioShell";
import { useProjects } from "@/lib/projects/storage";

export default function StudioPage() {
  const projects = useProjects();

  return (
    <AddShell className="max-w-5xl">
      <ProjectDashboard projects={projects} />
    </AddShell>
  );
}
