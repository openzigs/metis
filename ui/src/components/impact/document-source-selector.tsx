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
              {doc.filename} ({doc.projectName})
            </option>
          ))}
        </select>
      )}
    </Card>
  );
}
