"use client";

import { useEffect, useMemo } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { projectIdFromPath } from "@/lib/active-project";
import {
  resolveActiveWorkspaceId,
  useActiveWorkspaceId,
  workspaceListQuery,
  writeStoredActiveWorkspaceId as writeStoredWorkspaceId,
  type WorkspaceSummary as Workspace,
} from "@/lib/active-workspace";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";

/**
 * Header workspace switcher (Epic #759, Issue #766).
 * Dropdown shows all workspaces the user belongs to. Switching
 * sets the active workspace, which the project switcher lists (#1584).
 *
 * #1584 — on a project's pages the active workspace is that project's, so the
 * crumb never names one workspace over a project in another. A user who never
 * picked one (a second user, say) used to see their first workspace there.
 *
 * #2197 — and it is STORED, on purpose: opening a project in another workspace
 * switches the active workspace, as choosing it here would. The project
 * switcher, /projects, the wizard and the settings pages all read the stored
 * id, so they then agree with the crumb the user just saw. A render-only
 * override would leave the project switcher listing another workspace's
 * projects under this crumb, and flip the crumb back on leaving the page with
 * nothing chosen.
 */
export function WorkspaceSwitcher() {
  const router = useRouter();
  const pathId = projectIdFromPath(usePathname());
  const { data, isLoading } = useQuery(workspaceListQuery);
  // Shared with the project switcher and Overview: usually already cached.
  const pathProject = useQuery({
    queryKey: queryKeys.projects.detail(pathId ?? ""),
    queryFn: () => projectsApi.get(pathId as string),
    enabled: Boolean(pathId),
  });

  const workspaces: Workspace[] = useMemo(() => data ?? [], [data]);
  const isMember = (id: string | null | undefined): id is string =>
    Boolean(id) && workspaces.some((w) => w.id === id);

  const storedId = useActiveWorkspaceId();
  const projectWorkspaceId =
    pathId && !pathProject.isError ? pathProject.data?.workspaceId : undefined;
  const activeId = isMember(projectWorkspaceId)
    ? projectWorkspaceId
    : resolveActiveWorkspaceId(storedId, workspaces);
  const active = workspaces.find((w) => w.id === activeId) ?? null;

  useEffect(() => {
    if (activeId) writeStoredWorkspaceId(activeId);
  }, [activeId]);

  function handleSelect(ws: Workspace) {
    writeStoredWorkspaceId(ws.id);
    // A project page names its own workspace; leave it for the chosen one's
    // projects. (A project in no workspace is listed under every one.)
    if (pathId && projectWorkspaceId && projectWorkspaceId !== ws.id) router.push("/projects");
    // Pages that read the stored id on render pick the new one up.
    else router.refresh();
  }

  if (isLoading) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* #508 — the breadcrumb item around this can shrink (min-w-0); the trigger
            must shrink with it, truncating the label, or it paints over the next crumb. */}
        <Button
          variant="ghost"
          size="sm"
          className="min-w-0 gap-1.5 overflow-hidden text-sm font-medium"
          data-testid="workspace-switcher"
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 max-w-[120px] truncate">{active?.name ?? "Workspace"}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {workspaces.map((ws) => (
          <DropdownMenuItem
            key={ws.id}
            onClick={() => handleSelect(ws)}
            className="flex items-center gap-2"
          >
            <Building2 className="h-4 w-4 text-muted-foreground" />
            <span className="flex-1 truncate">{ws.name}</span>
            {ws.id === activeId && <span className="h-2 w-2 rounded-full bg-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => router.push("/settings/workspaces")}
          className="flex items-center gap-2 text-muted-foreground"
        >
          <Plus className="h-4 w-4" />
          <span>Create workspace</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
