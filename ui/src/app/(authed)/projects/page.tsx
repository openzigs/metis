"use client";

/**
 * Projects index — list, create, and link into the project workbench.
 */
import Link from "next/link";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Trash2 } from "lucide-react";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { ProjectMetaLine } from "@/components/projects/project-meta-line";
import { ProjectCreateForm } from "@/components/projects/project-create-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SkeletonText } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const WORKSPACE_STORAGE_KEY = "metis.activeWorkspaceId";

function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export default function ProjectsPage() {
  const qc = useQueryClient();
  const activeWorkspaceId = getActiveWorkspaceId();
  const list = useQuery({
    queryKey: queryKeys.projects.list({ workspaceId: activeWorkspaceId }),
    queryFn: () =>
      projectsApi.list(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined),
  });

  const [open, setOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => projectsApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      setDeleteTarget(null);
    },
  });

  return (
    <div className="space-y-6 p-2 md:p-0">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Browse, create, and manage migration projects.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button data-testid="new-project-button">New project</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create project</DialogTitle>
            </DialogHeader>
            <ProjectCreateForm workspaceId={activeWorkspaceId} onCreated={() => setOpen(false)} />
          </DialogContent>
        </Dialog>
      </header>

      {list.isLoading ? (
        <SkeletonText lines={4} />
      ) : list.error ? (
        <p role="alert" className="text-destructive">
          Failed to load projects.
        </p>
      ) : list.data && list.data.items.length > 0 ? (
        <div className="grid gap-3" data-testid="project-list">
          {list.data.items.map((project) => (
            <div key={project.id} className="relative">
              <Link href={`/projects/${project.id}`}>
                <Card className="cursor-pointer p-4 pr-12 transition hover:border-primary">
                  <div>
                    <h2 className="font-medium">{project.name}</h2>
                    <ProjectMetaLine slug={project.slug} status={project.status} />
                    {project.description ? (
                      <p className="mt-1 text-sm">{project.description}</p>
                    ) : null}
                  </div>
                </Card>
              </Link>
              <div className="absolute right-2 top-1/2 -translate-y-1/2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => e.preventDefault()}
                      aria-label="Project actions"
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onSelect={() => setDeleteTarget({ id: project.id, name: project.name })}
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          No projects yet. Create one to get started.
        </Card>
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete project</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Are you sure you want to delete{" "}
            <span className="font-medium text-foreground">{deleteTarget?.name}</span>? This cannot
            be undone.
          </p>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleteTarget && remove.mutate(deleteTarget.id)}
            >
              {remove.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
