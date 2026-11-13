"use client";

import { notFound, useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { ProjectTabs } from "@/components/projects/project-tabs";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  // #2450 — a project the viewer cannot open (absent, or in another
  // workspace) 404s on read. Every sub-page renders the shared not-found
  // boundary, as the Overview does (#143), rather than the project shell with
  // a heading stuck on "loading…" and forms whose every call 404s. Shares the
  // detail query the pages and the project switcher already read.
  const project = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => projectsApi.get(id),
    enabled: Boolean(id),
  });

  if (!id) return <div className="p-6">Invalid project id.</div>;
  if (project.error instanceof ApiError && project.error.status === 404) {
    notFound();
  }

  return (
    <div className="flex flex-col">
      <ProjectTabs projectId={id} />
      {children}
    </div>
  );
}
