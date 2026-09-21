"use client";

/**
 * Epic #157 — Document quarantine panel.
 *
 * Lists pending documents in the project's quarantine + lets a reviewer
 * approve / reject each one, toggle per-document trust, and toggle the
 * project-wide auto-approve flag. Gated by `document.upload`/`project.update`
 * server-side; the panel does not render permission gating itself.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { quarantineApi, type QuarantineRow } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const QK = (id: string) => ["quarantine", id] as const;

function ToggleCheckbox(props: {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
  testId?: string;
}) {
  return (
    <input
      type="checkbox"
      checked={props.checked}
      onChange={(e) => props.onChange(e.target.checked)}
      disabled={props.disabled}
      aria-label={props.ariaLabel}
      data-testid={props.testId}
      className="h-4 w-4"
    />
  );
}

export function QuarantinePanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: QK(projectId),
    queryFn: () => quarantineApi.list(projectId),
    enabled: Boolean(projectId),
  });

  const approve = useMutation({
    mutationFn: (documentId: string) => quarantineApi.approve(projectId, documentId),
    // Approval may have committed before cleanup failed. Reload on either outcome
    // so a failed initial approval becomes an explicit indexing retry.
    onSettled: () => qc.invalidateQueries({ queryKey: QK(projectId) }),
  });

  const reject = useMutation({
    mutationFn: (documentId: string) => quarantineApi.reject(projectId, documentId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK(projectId) }),
  });

  const toggleDoc = useMutation({
    mutationFn: (vars: { documentId: string; value: boolean }) =>
      quarantineApi.setDocAutoApprove(projectId, vars.documentId, vars.value),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK(projectId) }),
  });

  const toggleProject = useMutation({
    mutationFn: (value: boolean) => quarantineApi.setProjectAutoApprove(projectId, value),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK(projectId) }),
  });

  return (
    <Card className="space-y-4 p-4" data-testid="quarantine-panel">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Quarantine</h2>
        <label className="flex items-center gap-2 text-sm">
          <ToggleCheckbox
            checked={Boolean(list.data?.autoApproveTrustedSources)}
            onChange={(value) => toggleProject.mutate(value)}
            disabled={toggleProject.isPending}
            ariaLabel="Auto-approve trusted sources for this project"
            testId="project-auto-approve"
          />
          <span className="text-muted-foreground">Auto-approve trusted sources</span>
        </label>
      </div>

      {approve.isError && (
        <p role="alert" className="text-sm text-destructive">
          Unable to finish approval/indexing: {approve.error.message}
        </p>
      )}
      {list.isError && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>Unable to load quarantine: {list.error.message}</p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void list.refetch()}
            disabled={list.isFetching}
          >
            Retry loading quarantine
          </Button>
        </div>
      )}

      {list.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading quarantine…</p>
      ) : list.data && list.data.items.length > 0 ? (
        <ul className="divide-y" data-testid="quarantine-list">
          {list.data.items.map((row: QuarantineRow) => (
            <li
              key={row.documentId}
              className="flex items-center justify-between gap-3 py-2 text-sm"
              data-testid={`quarantine-row-${row.documentId}`}
            >
              <div>
                <p className="font-medium">{row.filename}</p>
                <p className="text-xs text-muted-foreground">
                  {row.chunkCount} chunks · uploaded {new Date(row.uploadedAt).toLocaleString()}
                </p>
                {row.indexState === "reconciling" && (
                  <div className="text-xs text-muted-foreground">
                    <p>Approval saved. Index cleanup is incomplete; retry indexing to finish.</p>
                    {row.errorMessage && <p className="text-destructive">{row.errorMessage}</p>}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                {row.indexState === "quarantined" && (
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <ToggleCheckbox
                      checked={row.autoApproveTrusted}
                      onChange={(value) => toggleDoc.mutate({ documentId: row.documentId, value })}
                      ariaLabel={`Auto-approve ${row.filename}`}
                    />
                    trust
                  </label>
                )}
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => approve.mutate(row.documentId)}
                  disabled={approve.isPending || reject.isPending}
                  data-testid={`approve-${row.documentId}`}
                >
                  {row.indexState === "reconciling"
                    ? approve.isPending && approve.variables === row.documentId
                      ? "Retrying indexing…"
                      : "Retry indexing"
                    : "Approve"}
                </Button>
                {row.indexState === "quarantined" && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => reject.mutate(row.documentId)}
                    disabled={reject.isPending || approve.isPending}
                    data-testid={`reject-${row.documentId}`}
                  >
                    Reject
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      ) : !list.isError ? (
        <p className="text-sm text-muted-foreground">Quarantine is empty.</p>
      ) : null}
    </Card>
  );
}
