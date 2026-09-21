"use client";

import { useParams } from "next/navigation";
import { ProjectTabs } from "@/components/projects/project-tabs";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  if (!id) return <div className="p-6">Invalid project id.</div>;

  return (
    <div className="flex flex-col">
      <ProjectTabs projectId={id} />
      {children}
    </div>
  );
}
