"use client";

/**
 * #731 — Workspace card on project Settings.
 *
 * A project created outside a workspace could never join one, so requirement
 * linking, workspace traceability and shared-database identities stayed off
 * for it for good. This card adds it to a workspace the user administers via
 * `PUT /api/projects/:id/workspace`. A project already in a workspace shows
 * which one; moving it between workspaces is not offered (the server refuses).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, apiFetch, refreshAccessToken } from "@/lib/api-client";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

interface MemberWorkspace {
  id: string;
  name: string;
  role: string;
}

const ADMIN_ROLES = new Set(["owner", "admin"]);

interface Props {
  projectId: string;
  workspaceId: string | null | undefined;
}

export function WorkspaceAssignCard({ projectId, workspaceId }: Props) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const workspaces = useQuery({
    queryKey: ["workspaces", "project-settings"],
    queryFn: () => apiFetch<MemberWorkspace[]>("/workspaces"),
  });

  const assign = useMutation({
    mutationFn: (target: string) => projectsApi.assignWorkspace(projectId, target),
    onSuccess: async () => {
      setError(null);
      setConfirming(false);
      // The token's workspace claim is minted at login; re-mint it so a
      // workspace created since then authorizes this project straight away.
      const refreshed = await refreshAccessToken();
      setNotice(
        refreshed
          ? null
          : "The project was added, but your session could not be refreshed. If it shows as not found, sign out and back in.",
      );
      await qc.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
    onError: (err: unknown) => {
      setConfirming(false);
      setError(err instanceof ApiError ? err.message : "Could not add the project to a workspace");
    },
  });

  const all = workspaces.data ?? [];
  const current = workspaceId ? all.find((w) => w.id === workspaceId) : undefined;
  const eligible = all.filter((w) => ADMIN_ROLES.has(w.role));

  return (
    <section
      className="space-y-3 rounded-md border p-4"
      data-testid="workspace-assign-card"
      aria-labelledby="workspace-assign-heading"
    >
      <div>
        <h3 id="workspace-assign-heading" className="text-sm font-semibold">
          Workspace
        </h3>
        <p className="text-xs text-muted-foreground">
          Requirement linking, workspace traceability and shared-database identities need the
          project to be in a workspace.
        </p>
      </div>
      {workspaceId ? (
        <p className="text-sm" data-testid="workspace-assign-current">
          In workspace <strong>{current?.name ?? workspaceId}</strong>.
        </p>
      ) : workspaces.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading workspaces…</p>
      ) : workspaces.isError ? (
        <p
          className="text-sm text-destructive"
          role="alert"
          data-testid="workspace-assign-load-error"
        >
          Could not load your workspaces. Reload the page to try again.
        </p>
      ) : eligible.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="workspace-assign-none">
          This project is not in a workspace. You need the owner or admin role in a workspace to add
          it to one; create a workspace under Settings → Workspaces.
        </p>
      ) : (
        <div className="flex items-end gap-2">
          <div className="flex-1 space-y-1">
            <Label htmlFor="workspace-assign-select">Add to workspace</Label>
            <select
              id="workspace-assign-select"
              data-testid="workspace-assign-select"
              className="w-full rounded-md border bg-background px-2 py-1 text-sm"
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setConfirming(false);
              }}
            >
              <option value="">Choose a workspace…</option>
              {eligible.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => setConfirming(true)}
            disabled={!selected || assign.isPending || confirming}
            data-testid="workspace-assign-button"
          >
            Add to workspace
          </Button>
        </div>
      )}
      {confirming && selected ? (
        <div
          className="space-y-2 rounded-md border border-destructive/50 p-3"
          role="alertdialog"
          aria-label="Confirm workspace move"
          data-testid="workspace-assign-confirm"
        >
          <p className="text-sm">
            Add this project to <strong>{eligible.find((w) => w.id === selected)?.name}</strong>?
            This cannot be undone. Anyone who is not a member of that workspace will lose access to
            the project.
          </p>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              onClick={() => assign.mutate(selected)}
              disabled={assign.isPending}
              data-testid="workspace-assign-confirm-button"
            >
              {assign.isPending ? "Adding…" : "Confirm move"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setConfirming(false)}
              disabled={assign.isPending}
              data-testid="workspace-assign-cancel-button"
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p className="text-sm text-muted-foreground" role="status">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
