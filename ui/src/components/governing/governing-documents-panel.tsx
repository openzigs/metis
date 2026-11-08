"use client";

/**
 * #1871 — a workspace's governing documents (Epic #1866).
 *
 * Lists the documents with their current revision's extraction state, rule
 * count and dropped-unverified count; a workspace admin uploads documents and
 * revisions, retries a failed extraction, and edits or removes rules. Every
 * member sees the list and the rules. The controls follow the caller's
 * workspace role, which the server enforces regardless (#1869).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { apiFetch } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { resolveErrorMessage } from "@/lib/use-app-mutation";
import {
  canManageGoverning,
  governingApi,
  governingKeys,
  isGoverningUnavailable,
  type GoverningDocumentListItem,
  type GoverningRevision,
} from "@/lib/governing-api";
import { GoverningRulesTable } from "./governing-rules-table";
import { GoverningUploadDialog, type UploadTarget } from "./governing-upload-dialog";

/** How often the list re-reads while an extraction is still pending or running. */
export const EXTRACTION_POLL_MS = 5000;

interface WorkspaceMembers {
  members: { role: string; user: { id: string } }[];
}

/** A revision whose extraction has not settled, so the list keeps polling. */
export function isExtractionUnsettled(state: string | undefined): boolean {
  return state === "pending" || state === "running";
}

/** `YYYY-MM-DD` of an ISO date, read in UTC so a date-only value never shifts a day. */
export function formatEffectiveDate(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : at.toISOString().slice(0, 10);
}

const STATE_VARIANT = {
  pending: "secondary",
  running: "info",
  done: "success",
  failed: "destructive",
} as const;

function ExtractionBadge({ state }: { state: string }) {
  const variant = STATE_VARIANT[state as keyof typeof STATE_VARIANT] ?? "outline";
  return <Badge variant={variant}>{state}</Badge>;
}

export function GoverningDocumentsPanel({ workspaceId }: { workspaceId: string }) {
  const { user } = useAuth();
  const [upload, setUpload] = useState<UploadTarget | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const workspace = useQuery({
    queryKey: ["workspace", workspaceId],
    queryFn: () => apiFetch<WorkspaceMembers>(`/workspaces/${workspaceId}`),
  });
  const canManage = canManageGoverning(workspace.data?.members, user);

  const list = useQuery({
    queryKey: governingKeys.list(workspaceId),
    queryFn: () => governingApi.list(workspaceId),
    refetchInterval: (query) =>
      query.state.data?.documents.some((d) =>
        isExtractionUnsettled(d.currentRevision?.extractionState),
      )
        ? EXTRACTION_POLL_MS
        : false,
  });

  if (list.isPending) {
    return <p className="text-sm text-muted-foreground">Loading governing documents…</p>;
  }
  if (list.isError) {
    if (isGoverningUnavailable(list.error)) {
      return (
        <EmptyState
          title="Governing documents are not available"
          description="This workspace does not have governing documents turned on."
        />
      );
    }
    return (
      <p role="alert" className="text-sm text-destructive">
        {resolveErrorMessage(list.error, "Could not load governing documents")}
      </p>
    );
  }

  const documents = list.data.documents;
  const selected = documents.find((d) => d.id === selectedId) ?? null;

  return (
    <div className="space-y-6">
      {canManage ? (
        <div className="flex justify-end">
          <Button type="button" onClick={() => setUpload({ kind: "document" })}>
            <Upload className="h-4 w-4" aria-hidden />
            Upload document
          </Button>
        </div>
      ) : null}

      {documents.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No governing documents yet"
          description={
            canManage
              ? "Upload a policy or control framework to extract its rules."
              : "A workspace admin uploads the policies and frameworks this workspace follows."
          }
        />
      ) : (
        <table className="w-full text-sm" aria-label="Governing documents">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th scope="col" className="py-2 pr-3">
                Title
              </th>
              <th scope="col" className="py-2 pr-3">
                Framework
              </th>
              <th scope="col" className="py-2 pr-3">
                Revision
              </th>
              <th scope="col" className="py-2 pr-3">
                Effective
              </th>
              <th scope="col" className="py-2 pr-3">
                Extraction
              </th>
              <th scope="col" className="py-2 pr-3">
                Rules
              </th>
              <th scope="col" className="py-2 pr-3">
                Dropped unverified
              </th>
              {canManage ? (
                <th scope="col" className="py-2">
                  <span className="sr-only">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <DocumentRow
                key={doc.id}
                workspaceId={workspaceId}
                doc={doc}
                selected={doc.id === selectedId}
                canManage={canManage}
                onSelect={() => setSelectedId(doc.id === selectedId ? null : doc.id)}
                onNewRevision={() =>
                  setUpload({ kind: "revision", documentId: doc.id, title: doc.title })
                }
              />
            ))}
          </tbody>
        </table>
      )}

      {selected ? (
        <SelectedDocument
          key={selected.id}
          workspaceId={workspaceId}
          doc={selected}
          canManage={canManage}
        />
      ) : null}

      <GoverningUploadDialog
        workspaceId={workspaceId}
        target={upload}
        onClose={() => setUpload(null)}
      />
    </div>
  );
}

function DocumentRow({
  workspaceId,
  doc,
  selected,
  canManage,
  onSelect,
  onNewRevision,
}: {
  workspaceId: string;
  doc: GoverningDocumentListItem;
  selected: boolean;
  canManage: boolean;
  onSelect: () => void;
  onNewRevision: () => void;
}) {
  const revision = doc.currentRevision;
  return (
    <tr className="border-b align-top">
      <td className="py-2 pr-3">
        <Button
          type="button"
          variant="link"
          className="h-auto p-0"
          aria-pressed={selected}
          onClick={onSelect}
        >
          {doc.title}
        </Button>
      </td>
      <td className="py-2 pr-3">{doc.framework ?? "—"}</td>
      <td className="py-2 pr-3">{revision?.revisionLabel ?? "—"}</td>
      <td className="py-2 pr-3">{revision ? formatEffectiveDate(revision.effectiveDate) : "—"}</td>
      <td className="py-2 pr-3">
        {revision ? (
          <ExtractionCell
            workspaceId={workspaceId}
            doc={doc}
            revision={revision}
            canManage={canManage}
            onNewRevision={onNewRevision}
          />
        ) : (
          "—"
        )}
      </td>
      <td className="py-2 pr-3">
        {revision?.extractionState === "done" ? (
          <RuleCount workspaceId={workspaceId} documentId={doc.id} />
        ) : (
          "—"
        )}
      </td>
      <td className="py-2 pr-3">{revision ? revision.droppedUnverified : "—"}</td>
      {canManage ? (
        <td className="py-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`New revision of ${doc.title}`}
            onClick={onNewRevision}
          >
            New revision
          </Button>
        </td>
      ) : null}
    </tr>
  );
}

/** The state badge; a failed extraction also shows its error and the way out. */
function ExtractionCell({
  workspaceId,
  doc,
  revision,
  canManage,
  onNewRevision,
}: {
  workspaceId: string;
  doc: GoverningDocumentListItem;
  revision: GoverningRevision;
  canManage: boolean;
  onNewRevision: () => void;
}) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => governingApi.retryExtraction(workspaceId, doc.id, revision.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: governingKeys.all(workspaceId) }),
  });

  if (revision.extractionState !== "failed") {
    return <ExtractionBadge state={revision.extractionState} />;
  }
  return (
    <div className="space-y-1">
      <ExtractionBadge state="failed" />
      <p className="text-xs text-destructive">
        {revision.extractionError ?? "Rule extraction failed."}
      </p>
      {canManage ? (
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Retry extraction of ${doc.title}`}
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
          >
            Retry extraction
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Re-upload ${doc.title}`}
            onClick={onNewRevision}
          >
            Re-upload
          </Button>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          A workspace admin can retry it or upload a new revision.
        </p>
      )}
      {retry.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {resolveErrorMessage(retry.error, "Could not retry the extraction")}
        </p>
      ) : null}
    </div>
  );
}

function RuleCount({ workspaceId, documentId }: { workspaceId: string; documentId: string }) {
  const rules = useQuery({
    queryKey: governingKeys.rules(workspaceId, documentId),
    queryFn: () => governingApi.rules(workspaceId, documentId),
  });
  return <>{rules.data ? rules.data.rules.length : "…"}</>;
}

/** The selected document's rules, with a revision picker once it has more than one. */
function SelectedDocument({
  workspaceId,
  doc,
  canManage,
}: {
  workspaceId: string;
  doc: GoverningDocumentListItem;
  canManage: boolean;
}) {
  const [revisionId, setRevisionId] = useState<string | undefined>(undefined);
  const detail = useQuery({
    queryKey: governingKeys.document(workspaceId, doc.id),
    queryFn: () => governingApi.get(workspaceId, doc.id),
  });
  const revisions = detail.data?.document.revisions ?? [];

  if (!doc.currentRevision) {
    return <p className="text-sm text-muted-foreground">This document has no revision yet.</p>;
  }

  return (
    <div className="space-y-3">
      {revisions.length > 1 ? (
        <div className="flex items-center gap-2">
          <Label htmlFor="governing-revision">Revision</Label>
          <select
            id="governing-revision"
            className="h-9 rounded-md border bg-background px-2 text-sm"
            value={revisionId ?? ""}
            onChange={(e) => setRevisionId(e.target.value || undefined)}
          >
            {revisions.map((rev) => (
              <option key={rev.id} value={rev.isCurrent ? "" : rev.id}>
                {rev.revisionLabel}
                {rev.isCurrent ? " (current)" : ""}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <GoverningRulesTable
        workspaceId={workspaceId}
        documentId={doc.id}
        documentTitle={doc.title}
        revisionId={revisionId}
        canManage={canManage}
      />
    </div>
  );
}
