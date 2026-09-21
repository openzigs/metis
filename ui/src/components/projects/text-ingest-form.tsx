"use client";

/**
 * Issue #132 — paste raw markdown/text/etc. and ingest it as a document.
 *
 * Useful for clipboard transcripts, agent runs, ad-hoc notes that don't
 * already live in a file. Same size cap and pipeline as multipart upload.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { documentsApi, type DocumentRow } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  onIngested?: (doc: DocumentRow) => void;
}

export function TextIngestForm({ projectId, onIngested }: Props) {
  const [filename, setFilename] = useState("note.md");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const ingest = useMutation({
    mutationFn: () => documentsApi.createFromText(projectId, { filename, content }),
    onSuccess: (data) => {
      setError(null);
      setStatus(`Saved ${data.document.filename} (${data.document.status})`);
      setContent("");
      onIngested?.(data.document);
    },
    onError: (err: unknown) => {
      setStatus(null);
      setError(err instanceof ApiError ? err.message : "Import failed");
    },
  });

  function trySubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setStatus(null);
    if (filename.trim().length === 0) {
      setError("Filename is required");
      return;
    }
    if (content.trim().length === 0) {
      setError("Content is required");
      return;
    }
    ingest.mutate();
  }

  return (
    <form
      className="space-y-2 rounded-md border p-3"
      onSubmit={trySubmit}
      data-testid="text-ingest-form"
    >
      <Label htmlFor="ingest-text-filename">Paste text</Label>
      <div className="flex items-center gap-2">
        <Input
          id="ingest-text-filename"
          placeholder="note.md"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          data-testid="text-ingest-filename"
        />
        <Button
          type="submit"
          disabled={ingest.isPending || content.trim().length === 0}
          data-testid="text-ingest-submit"
        >
          {ingest.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
      <textarea
        id="ingest-text-content"
        className="min-h-[120px] w-full rounded-md border bg-background p-2 text-sm font-mono"
        placeholder="Paste markdown / plain text…"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        data-testid="text-ingest-content"
      />
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
    </form>
  );
}
