"use client";

/**
 * Epic #157 — Document quarantine panel.
 *
 * Lists pending documents in the project's quarantine + lets a reviewer
 * approve / reject each one, toggle per-document trust, and toggle the
 * project-wide auto-approve flag. Gated by `document.upload`/`project.update`
 * server-side; the panel does not render permission gating itself.
 *
 * #2547 — each row shows the document's "Restricted" badge, and a reviewer
 * holding `document.upload` who can read the document may set its access
 * list before approving it (not on an archived project, whose access lists
 * the server freezes). A reviewer the document's access list leaves out is
 * offered no approve, reject or trust toggle for it: the server refuses them
 * (403 `DOCUMENT_RESTRICTED`), as it refuses their access-list edit.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hasPermission } from "@metis/shared";
import { useAuth } from "@/lib/auth-context";
import { quarantineApi, type QuarantineRow } from "@/lib/projects-api";
import { isUnreadableDocument } from "@/lib/document-access";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { AclEditor } from "@/components/projects/acl-editor";
import { RestrictedBadge } from "@/components/projects/restricted-badge";

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

export function QuarantinePanel({
  projectId,
  isArchived = false,
}: {
  projectId: string;
  /** #2547 — an archived project offers no access-list editor. */
  isArchived?: boolean;
}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const canEditAccess = user ? hasPermission(user.role, "document.upload") : false;
  const [accessOpenFor, setAccessOpenFor] = useState<string | null>(null);
  const list = useQuery({
    queryKey: QK(projectId),
    queryFn: () => quarantineApi.list(projectId),
    enabled: Boolean(projectId),
  });

  const approve = useMutation({
    mutationFn: (documentId: string) => quarantineApi.approve(projectId, documentId),
    // Approval may have committed before cleanup failed. Reload on either outcome
    // so a failed initial approval becomes an explicit indexing retry.
    //
    // React Query holds a mutation in `pending` until the promise `onSettled`
    // returns has resolved. On success that is wanted: the row keeps its
    // disabled "Retrying indexing…" button until the refreshed list drops it. On
    // failure it is not: awaiting the refresh there hid the approval error — and
    // kept the button disabled — for as long as an unrelated list GET took, so a
    // slow refresh read as "the failure was never reported" (#220).
    onSettled: (_data, error) => {
      const refreshed = qc.invalidateQueries({ queryKey: QK(projectId) });
      return error ? undefined : refreshed;
    },
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
    // `id` — the Overview's Review stage links here (#66).
    <Card id="quarantine" className="scroll-mt-4 space-y-4 p-4" data-testid="quarantine-panel">
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
          {list.data.items.map((row: QuarantineRow) => {
            const accessOpen = accessOpenFor === row.documentId;
            // #2547 — a reviewer who cannot read the document cannot manage it.
            const unreadable = isUnreadableDocument(row);
            return (
              <li
                key={row.documentId}
                className="space-y-2 py-2 text-sm"
                data-testid={`quarantine-row-${row.documentId}`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium">{row.filename}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.chunkCount} {row.chunkCount === 1 ? "section" : "sections"} · uploaded{" "}
                      {new Date(row.uploadedAt).toLocaleString()}
                    </p>
                    <RestrictedBadge
                      access={unreadable ? { restricted: true, canRead: false } : row.access}
                      testId={`quarantine-restricted-${row.documentId}`}
                    />
                    {row.indexState === "reconciling" && (
                      <div className="text-xs text-muted-foreground">
                        <p>
                          Approval saved. Index cleanup is incomplete; retry indexing to finish.
                        </p>
                        {row.errorMessage && <p className="text-destructive">{row.errorMessage}</p>}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {row.indexState === "quarantined" && !unreadable && (
                      <label className="flex items-center gap-1 text-xs text-muted-foreground">
                        <ToggleCheckbox
                          checked={row.autoApproveTrusted}
                          onChange={(value) =>
                            toggleDoc.mutate({ documentId: row.documentId, value })
                          }
                          ariaLabel={`Auto-approve ${row.filename}`}
                        />
                        trust
                      </label>
                    )}
                    {!unreadable && (
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
                    )}
                    {row.indexState === "quarantined" && !unreadable && (
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
                    {unreadable ? (
                      <span
                        className="text-xs text-muted-foreground"
                        data-testid={`quarantine-unreadable-${row.documentId}`}
                      >
                        Only its readers or an admin can review it
                      </span>
                    ) : null}
                    {canEditAccess && !isArchived && !unreadable ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-expanded={accessOpen}
                        onClick={() => setAccessOpenFor(accessOpen ? null : row.documentId)}
                        data-testid={`quarantine-access-toggle-${row.documentId}`}
                      >
                        {accessOpen ? "Close access" : "Access"}
                      </Button>
                    ) : null}
                  </div>
                </div>
                {accessOpen ? (
                  <AclEditor
                    projectId={projectId}
                    documentId={row.documentId}
                    initialSubjects={row.access?.subjects ?? []}
                    initialUsers={row.access?.users}
                    onSaved={() => setAccessOpenFor(null)}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : !list.isError ? (
        <p className="text-sm text-muted-foreground">Quarantine is empty.</p>
      ) : null}
    </Card>
  );
}
