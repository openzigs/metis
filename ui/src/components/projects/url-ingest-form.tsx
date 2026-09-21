"use client";

/**
 * Issue #132 — paste a URL and ingest its content into the project.
 *
 * Server-side fetch enforces SSRF protections (no private IPs, optional
 * hostname allow-list) so we don't need to gate anything from the browser
 * beyond a basic URL well-formedness check.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { urlSuggestionMessage, urlProtocolSuggestionMessage } from "@/lib/error-suggestion";
import { documentsApi, type DocumentRow } from "@/lib/projects-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Props {
  projectId: string;
  onIngested?: (doc: DocumentRow) => void;
}

export function UrlIngestForm({ projectId, onIngested }: Props) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const ingest = useMutation({
    mutationFn: () => documentsApi.createFromUrl(projectId, { url }),
    onSuccess: (data) => {
      setError(null);
      setStatus(`Imported ${data.document.filename} (${data.document.status})`);
      setUrl("");
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
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      // SC 3.3.3 — suggest a corrected URL derived from the entry when possible.
      setError(urlSuggestionMessage(url));
      return;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      setError(urlProtocolSuggestionMessage(url));
      return;
    }
    ingest.mutate();
  }

  return (
    <form
      className="space-y-2 rounded-md border p-3"
      onSubmit={trySubmit}
      data-testid="url-ingest-form"
    >
      <Label htmlFor="ingest-url">Add from URL</Label>
      <div className="flex items-end gap-2">
        <Input
          id="ingest-url"
          type="url"
          placeholder="https://example.com/docs/page.md"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          data-testid="url-ingest-input"
        />
        <Button
          type="submit"
          disabled={ingest.isPending || url.trim().length === 0}
          data-testid="url-ingest-submit"
        >
          {ingest.isPending ? "Fetching…" : "Fetch"}
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
    </form>
  );
}
