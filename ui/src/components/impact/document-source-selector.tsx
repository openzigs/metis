/**
 * DocumentSourceSelector — Epic #159 (#164).
 *
 * The requirements-change input can come from either pasted text or an
 * already-ingested document. Pure/controlled component.
 */
"use client";

import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

export type SourceMode = "text" | "document";

export interface SourceDocument {
  id: string;
  filename: string;
  projectName: string;
  /**
   * #2547 — the document has an access list the caller is on. (One it leaves
   * out is not offered at all: the page drops it, #2546.)
   */
  restricted?: boolean;
  /**
   * #2555 — the document is quarantined, awaiting review (`indexState`), as the
   * Analysis page's picker labels it.
   */
  awaitingReview?: boolean;
}

/**
 * #2547 — the option's text: a restricted document says so. #2555 — and one
 * awaiting review says that.
 */
export function optionLabel(doc: SourceDocument): string {
  const marks = [
    ...(doc.restricted ? ["restricted"] : []),
    ...(doc.awaitingReview ? ["awaiting review"] : []),
  ];
  const base = `${doc.filename} (${doc.projectName})`;
  return marks.length > 0 ? `${base} — ${marks.join(", ")}` : base;
}

/** #2555 — how many of the listed documents are awaiting review, said under the list. */
export function awaitingReviewNote(documents: readonly SourceDocument[]): string | null {
  const n = documents.filter((d) => d.awaitingReview).length;
  if (n === 0) return null;
  return n === 1
    ? "1 of these documents is awaiting review: it has not been approved yet."
    : `${n} of these documents are awaiting review: they have not been approved yet.`;
}

export interface DocumentSourceSelectorProps {
  mode: SourceMode;
  onModeChange: (mode: SourceMode) => void;
  text: string;
  onTextChange: (text: string) => void;
  documents: SourceDocument[];
  documentId: string | null;
  onDocumentChange: (id: string | null) => void;
  documentsLoading?: boolean;
}

export function DocumentSourceSelector({
  mode,
  onModeChange,
  text,
  onTextChange,
  documents,
  documentId,
  onDocumentChange,
  documentsLoading = false,
}: DocumentSourceSelectorProps) {
  return (
    <Card className="space-y-3 p-4" data-testid="document-source-selector">
      <h2 className="text-sm font-medium">Requirement change</h2>

      <div className="flex gap-4 text-sm" role="radiogroup" aria-label="Change source">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="impact-source-mode"
            checked={mode === "text"}
            onChange={() => onModeChange("text")}
            data-testid="source-mode-text"
          />
          <span>Paste text</span>
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="radio"
            name="impact-source-mode"
            checked={mode === "document"}
            onChange={() => onModeChange("document")}
            data-testid="source-mode-document"
          />
          <span>Existing document</span>
        </label>
      </div>

      {mode === "text" ? (
        <Textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          placeholder="Paste the new or changed requirements here…"
          rows={8}
          data-testid="source-text-input"
          aria-label="Requirement change text"
        />
      ) : documentsLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="source-documents-loading">
          Loading documents…
        </p>
      ) : documents.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="source-documents-empty">
          No documents found in the selected projects.
        </p>
      ) : (
        <div className="space-y-1">
          <select
            className="w-full rounded border bg-background px-2 py-1 text-sm"
            value={documentId ?? ""}
            onChange={(e) => onDocumentChange(e.target.value || null)}
            data-testid="source-document-select"
            aria-label="Select a document"
          >
            <option value="">Select a document…</option>
            {documents.map((doc) => (
              <option key={doc.id} value={doc.id}>
                {optionLabel(doc)}
              </option>
            ))}
          </select>
          {awaitingReviewNote(documents) ? (
            <p
              className="text-xs text-muted-foreground"
              data-testid="source-documents-awaiting-review"
            >
              {awaitingReviewNote(documents)}
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}
