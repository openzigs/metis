"use client";

import { useEffect, useMemo } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChevronsUpDown, FolderKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { projectsApi, type Project } from "@/lib/projects-api";

const STORAGE_KEY = "metis.activeProjectId";

function readStoredActiveId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredActiveId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow */
  }
}

/**
 * Extract the project id from `/projects/<id>/...` paths so the switcher
 * always reflects the project the user is actually looking at, even after
 * a hard reload.
 */
function projectIdFromPath(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/projects\/([^/?#]+)(?:[/?#]|$)/);
  return match?.[1] ?? null;
}

/**
 * Header switcher backed by the real `/api/projects` endpoint. Falls back to
 * a placeholder label until the list resolves so users never see stale mock
 * data. The active id is persisted in localStorage and overridden by the
 * current URL when the user is inside `/projects/<id>/...`.
 */
export function ProjectSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const projects = useQuery({
    queryKey: ["projects", "switcher"],
    queryFn: () => projectsApi.list({ limit: 50 }),
    staleTime: 30_000,
  });

  const items: readonly Project[] = useMemo(
    () => projects.data?.items ?? [],
    [projects.data?.items],
  );

  const pathId = projectIdFromPath(pathname);
  const storedId = typeof window === "undefined" ? null : readStoredActiveId();
  const activeId =
    pathId ??
    (storedId && items.some((p) => p.id === storedId) ? storedId : (items[0]?.id ?? null));
  const active = items.find((p) => p.id === activeId) ?? null;

  // Persist whenever the resolved active project changes (URL or selection).
  useEffect(() => {
    if (activeId) writeStoredActiveId(activeId);
  }, [activeId]);

  const label = active?.name ?? (projects.isLoading ? "Loading…" : "No project");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label={`Active project: ${label}`}
          disabled={items.length === 0}
        >
          <FolderKanban className="h-4 w-4" aria-hidden />
          <span className="max-w-[12rem] truncate">{label}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-60" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Switch project</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <DropdownMenuItem disabled>No projects available</DropdownMenuItem>
        ) : (
          items.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => {
                writeStoredActiveId(project.id);
                router.push(`/projects/${project.id}`);
              }}
              aria-current={project.id === activeId}
            >
              {project.name}
            </DropdownMenuItem>
          ))
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
