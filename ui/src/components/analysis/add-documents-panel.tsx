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
import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { urlSuggestionMessage, urlProtocolSuggestionMessage } from "@/lib/error-suggestion";
import { documentsApi, type DocumentRow } from "@/lib/projects-api";
import { formatSourceLabel } from "@/lib/format-source-label";
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
      return "bg-emerald-500/15 text-emerald-300 border-emerald-500/30";
    case "failed":
      return "bg-red-500/15 text-red-300 border-red-500/30";
    default:
      return "bg-blue-500/15 text-blue-300 border-blue-500/30";
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
      <div className="max-h-40 space-y-1 overflow-y-auto rounded border border-zinc-800 p-2">
        {loading ? <p className="text-xs text-zinc-500">Loading documents…</p> : null}
        {!loading && docs.length === 0 ? (
          <p className="text-xs text-zinc-500">No documents yet — add one below.</p>
        ) : null}
        {docs.map((d) => {
          const ready = d.status === "ready";
          const checked = selectedDocs.includes(d.id);
          // Issue #427 — render connector ids as a human-readable `basename —
          // repo` label while keeping the full raw id in the title/tooltip so it
          // stays copyable / deep-linkable. Non-connector filenames pass through
          // unchanged (graceful degradation).
          const source = formatSourceLabel(d.filename);
          return (
            <label
              key={d.id}
              className="flex items-center gap-2 text-sm"
              data-testid={`add-documents-row-${d.id}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={!ready}
                onChange={(e) => {
                  onSelectedDocsChange(
                    e.target.checked
                      ? uniq([...selectedDocs, d.id])
                      : selectedDocs.filter((id) => id !== d.id),
                  );
                }}
              />
              <span className="truncate" title={source.rawId}>
                {source.label}
              </span>
              {!ready ? (
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
        <p
          className="mt-2 text-xs text-amber-400"
          role="status"
          data-testid="add-documents-warning"
        >
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
                className="text-xs text-red-400"
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
