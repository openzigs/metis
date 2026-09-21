"use client";

import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { projectsApi } from "@/lib/projects-api";
import { WorkspaceSwitcher } from "./workspace-switcher";
import { ProjectSwitcher } from "./project-switcher";

/**
 * N7 (#152) — consolidate the former dual header switchers into a single
 * breadcrumb hierarchy: Workspace › Project. Each crumb is itself a switcher
 * menu. Degrades to workspace-only when no project context exists.
 */
export function Breadcrumbs() {
  const pathname = usePathname() ?? "";
  const projects = useQuery({
    queryKey: ["projects", "switcher"],
    queryFn: () => projectsApi.list({ limit: 50 }),
    staleTime: 30_000,
  });

  const hasProjects = (projects.data?.items.length ?? 0) > 0;
  const onProjectPath = /^\/projects\/[^/]+/.test(pathname);
  const showProject = hasProjects || onProjectPath;

  return (
    <nav aria-label="Breadcrumb" data-testid="header-breadcrumb">
      <ol className="flex items-center gap-1">
        <li aria-current={showProject ? undefined : "page"}>
          <WorkspaceSwitcher />
        </li>
        {showProject ? (
          <>
            <li aria-hidden="true" className="text-muted-foreground">
              <ChevronRight className="h-4 w-4" />
            </li>
            <li aria-current="page">
              <ProjectSwitcher />
            </li>
          </>
        ) : null}
      </ol>
    </nav>
  );
}
