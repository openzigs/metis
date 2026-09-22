"use client";

import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
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
import { apiFetch } from "@/lib/api-client";

interface Workspace {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  role: string;
}

const STORAGE_KEY = "metis.activeWorkspaceId";

function readStoredWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredWorkspaceId(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(STORAGE_KEY, id);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow */
  }
}

async function fetchWorkspaces(): Promise<Workspace[]> {
  try {
    return await apiFetch<Workspace[]>("/workspaces");
  } catch {
    return [];
  }
}

/**
 * Header workspace switcher (Epic #759, Issue #766).
 * Dropdown shows all workspaces the user belongs to. Switching
 * sets the active workspace and triggers a project list refetch.
 */
export function WorkspaceSwitcher() {
  const router = useRouter();
  const { data, isLoading } = useQuery({
    queryKey: ["workspaces", "switcher"],
    queryFn: fetchWorkspaces,
    staleTime: 60_000,
  });

  const workspaces: Workspace[] = useMemo(() => data ?? [], [data]);

  const storedId = readStoredWorkspaceId();
  const activeId =
    storedId && workspaces.some((w) => w.id === storedId) ? storedId : (workspaces[0]?.id ?? null);
  const active = workspaces.find((w) => w.id === activeId) ?? null;

  useEffect(() => {
    if (activeId) writeStoredWorkspaceId(activeId);
  }, [activeId]);

  function handleSelect(ws: Workspace) {
    writeStoredWorkspaceId(ws.id);
    // Force re-render — refresh project list for new workspace
    router.refresh();
  }

  if (isLoading) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-sm font-medium"
          data-testid="workspace-switcher"
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="max-w-[120px] truncate">{active?.name ?? "Workspace"}</span>
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
          onClick={() => router.push("/admin/workspaces")}
          className="flex items-center gap-2 text-muted-foreground"
        >
          <Plus className="h-4 w-4" />
          <span>Create workspace</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
