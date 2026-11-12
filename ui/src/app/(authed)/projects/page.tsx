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
import {
  NewProjectDialog,
  ProjectCreateForbiddenNotice,
} from "@/components/projects/new-project-wizard";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SkeletonText } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PageHeader } from "@/components/ui/page-header";
import { useValidatedActiveWorkspaceId } from "@/lib/active-workspace";
import { useAuth } from "@/lib/auth-context";

export default function ProjectsPage() {
  const qc = useQueryClient();
  // #2368 — offer a write action only to a role holding the key its route
  // checks (`POST /api/projects`, `DELETE /api/projects/:id`). Hiding is not
  // access control: the server refuses either way.
  const { user } = useAuth();
  const canCreate = user?.permissions.includes("project.create") ?? false;
  const canDelete = user?.permissions.includes("project.delete") ?? false;
  // #2197 — the validated id, not the raw stored one: a workspace the caller is
  // not in (a second user on a shared browser) filtered the list down to the
  // unassigned projects. Subscribed, so a switch in the top bar re-lists.
  const workspace = useValidatedActiveWorkspaceId();
  const activeWorkspaceId = workspace.workspaceId;
  const list = useQuery({
    queryKey: queryKeys.projects.list({ workspaceId: activeWorkspaceId }),
    queryFn: () =>
      projectsApi.list(activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined),
    enabled: workspace.status !== "loading",
  });

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
      <PageHeader
        title="Projects"
        description="Browse, create, and manage projects."
        // #2349 — the same wizard as Home and the command palette, whatever the count.
        actions={
          canCreate ? (
            <NewProjectDialog triggerTestId="new-project-button" />
          ) : (
            <ProjectCreateForbiddenNotice />
          )
        }
      />

      {workspace.status === "loading" || list.isLoading ? (
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
              {/* Delete is the menu's only item, so without project.delete the
                  menu itself is not offered. */}
              {canDelete ? (
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
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <Card className="p-6 text-center text-sm text-muted-foreground">
          {canCreate
            ? "No projects yet. Create one to get started."
            : "No projects yet. Ask an admin or coordinator to create one."}
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
