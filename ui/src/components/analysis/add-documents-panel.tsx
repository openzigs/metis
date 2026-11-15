"use client";

/**
 * Issue #906 — inline "Add documents" panel for the Analysis page.
 *
 * Surfaces the already-existing upload primitives (file drag-drop, paste text,
 * URL) directly on the Analysis page so users can add business documents
 * without leaving for the Documents page. It also renders the document
 * selection list (the docs that feed the run).
 *
 * On a successful ingest it **awaits** a cache invalidation (via
 * {@link Props.onInvalidateDocs}) *before* auto-selecting the new document, so
 * the freshly-uploaded row is present in the query cache when it is checked.
 *
 * Uploaded docs land `pending`/`processing` first; their ingest status is
 * surfaced and a warning is shown while any selected document is not yet
 * `ready`, so users do not run against half-ingested content.
 *
 * Collapsed by default; toggled via the in-house `aria-expanded` convention
 * (no accordion primitive), matching `data-mappings-panel.tsx`.
 */
import { useEffect, useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { urlSuggestionMessage, urlProtocolSuggestionMessage } from "@/lib/error-suggestion";
import { documentsApi, type DocumentRow } from "@/lib/projects-api";
import { isUnreadableDocument } from "@/lib/document-access";
import { DocumentName } from "@/components/projects/document-name";
import { RestrictedBadge } from "@/components/projects/restricted-badge";
import { useRepoNames } from "@/hooks/use-repo-names";
import { DocumentUploader } from "@/components/projects/document-uploader";
import { TextIngestForm } from "@/components/projects/text-ingest-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  /** All documents for the project (ready + in-flight) from the page query. */
  docs: DocumentRow[];
  /** Currently-selected document ids. */
  selectedDocs: string[];
  /** Replace the selected document ids. */
  onSelectedDocsChange: (ids: string[]) => void;
  /**
   * Invalidate the documents query and resolve once refetched. Awaited before
   * a newly-ingested document is auto-selected.
   */
  onInvalidateDocs: () => Promise<unknown>;
  /** Whether the documents query is still loading. */
  loading?: boolean;
}

function uniq(ids: string[]): string[] {
  return [...new Set(ids)];
}

function statusBadgeClass(status: DocumentRow["status"]): string {
  switch (status) {
    case "ready":
      return "bg-success-muted text-success border-success/40";
    case "failed":
      return "bg-destructive/10 text-destructive border-destructive/40";
    default:
      return "bg-info-muted text-info border-info/40";
  }
}

export function AddDocumentsPanel({
  projectId,
  docs,
  selectedDocs,
  onSelectedDocsChange,
  onInvalidateDocs,
  loading = false,
}: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);
  const panelId = useId();
  // #23 — label repo files with the repository's name, not the id tail.
  const repoNames = useRepoNames(projectId);

  // #2547 — a document picked before a refetch marked it unreadable (its
  // access list changed) leaves the selection, so what the run is sent and
  // the change request is named after match the unchecked box.
  useEffect(() => {
    const unreadable = new Set(docs.filter(isUnreadableDocument).map((d) => d.id));
    if (selectedDocs.some((id) => unreadable.has(id))) {
      onSelectedDocsChange(selectedDocs.filter((id) => !unreadable.has(id)));
    }
  }, [docs, selectedDocs, onSelectedDocsChange]);

  /** Await invalidation, then auto-select the freshly-ingested document. */
  async function handleAdded(doc: DocumentRow): Promise<void> {
    await onInvalidateDocs();
    onSelectedDocsChange(uniq([...selectedDocs, doc.id]));
  }

  const urlMutation = useMutation({
    mutationFn: () => documentsApi.createFromUrl(projectId, { url: url.trim() }),
    onSuccess: async (res) => {
      setUrlError(null);
      setUrl("");
      await handleAdded(res.document);
    },
    onError: (err: unknown) => {
      setUrlError(err instanceof ApiError ? err.message : "Failed to fetch URL");
    },
  });

  // SC 3.3.3 — a scheme-less or non-http(s) URL has a client-detectable cause,
  // so derive and suggest the corrected value (e.g. add https://) before the
  // network call instead of surfacing only the raw server error. Mirrors
  // `url-ingest-form.tsx`.
  function handleUrlSubmit(): void {
    setUrlError(null);
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      setUrlError(urlSuggestionMessage(url));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setUrlError(urlProtocolSuggestionMessage(url));
      return;
    }
    urlMutation.mutate();
  }

  const selectedNotReady = docs.filter((d) => selectedDocs.includes(d.id) && d.status !== "ready");

  return (
    <div data-testid="add-documents-panel">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Label>Documents (optional)</Label>
        <Button
          size="sm"
          variant="outline"
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((v) => !v)}
          data-testid="add-documents-toggle"
        >
          {expanded ? "Done" : "Add documents"}
        </Button>
      </div>

      {/* Document selection list (ready docs selectable; in-flight docs shown
          with their ingest status so users see them arrive). */}
      <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-border p-2">
        {loading ? <p className="text-xs text-muted-foreground">Loading documents…</p> : null}
        {!loading && docs.length === 0 ? (
          <p className="text-xs text-muted-foreground">No documents yet — add one below.</p>
        ) : null}
        {docs.map((d) => {
          const ready = d.status === "ready";
          // #2547 — a document restricted away from the caller is listed,
          // marked, and cannot be picked for the change request.
          const unreadable = isUnreadableDocument(d);
          const checked = selectedDocs.includes(d.id) && !unreadable;
          return (
            <label
              key={d.id}
              className="flex items-center gap-2 text-sm"
              data-testid={`add-documents-row-${d.id}`}
            >
              <input
                type="checkbox"
                checked={checked}
                // #2546 / #2547 — a document restricted from the caller is not read by their run.
                disabled={!ready || unreadable}
                onChange={(e) => {
                  onSelectedDocsChange(
                    e.target.checked
                      ? uniq([...selectedDocs, d.id])
                      : selectedDocs.filter((id) => id !== d.id),
                  );
                }}
              />
              {/* Issue #363 — path over repository label; the internal key
                  is only the tooltip. */}
              <DocumentName filename={d.filename} source={d.source} repoNames={repoNames} />
              <RestrictedBadge
                access={unreadable ? { restricted: true, canRead: false } : d.access}
                testId={`add-documents-restricted-badge-${d.id}`}
              />
              {unreadable ? (
                <span
                  className="ml-auto text-xs text-muted-foreground"
                  data-testid={`add-documents-restricted-${d.id}`}
                >
                  You don&apos;t have access to this document
                </span>
              ) : !ready ? (
                <span
                  className={`ml-auto inline-block rounded border px-1.5 py-0.5 text-[10px] ${statusBadgeClass(d.status)}`}
                  data-testid={`add-documents-status-${d.id}`}
                >
                  {d.status}
                </span>
              ) : null}
            </label>
          );
        })}
      </div>

      {selectedNotReady.length > 0 ? (
        <p className="mt-2 text-xs text-warning" role="status" data-testid="add-documents-warning">
          {selectedNotReady.length} selected document
          {selectedNotReady.length === 1 ? " is" : "s are"} still ingesting — wait until ready
          before running.
        </p>
      ) : null}

      {expanded ? (
        <div id={panelId} className="mt-3 space-y-3" data-testid="add-documents-controls">
          <DocumentUploader projectId={projectId} onUploaded={handleAdded} />
          <TextIngestForm projectId={projectId} onIngested={handleAdded} />
          <div className="space-y-1">
            <Label htmlFor="add-documents-url">Add from URL</Label>
            <div className="flex items-center gap-2">
              <Input
                id="add-documents-url"
                type="url"
                placeholder="https://example.com/spec.md"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                data-testid="add-documents-url-input"
              />
              <Button
                type="button"
                variant="outline"
                disabled={url.trim().length === 0 || urlMutation.isPending}
                onClick={handleUrlSubmit}
                data-testid="add-documents-url-submit"
              >
                {urlMutation.isPending ? "Fetching…" : "Fetch"}
              </Button>
            </div>
            {urlError ? (
              <p
                className="text-xs text-destructive"
                role="alert"
                data-testid="add-documents-url-error"
              >
                {urlError}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
