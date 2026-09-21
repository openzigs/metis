"use client";

/**
 * Epic #596 / Issue #122 — "Rebuild AST cache" control for the repositories tab.
 *
 * Triggers POST .../rebuild-cache and renders an explicit status display:
 * idle → in-progress → completed (with rebuild stats) or failed (with a
 * parsed error message, never a raw JSON blob). A failed rebuild never leaves
 * a misleading "completed" state.
 *
 * Provider guardrail: AST cache rebuild is analysis plumbing — it does not
 * touch provider routing for Bedrock or local-gemma.
 */
import { useState } from "react";
import { ApiError } from "@/lib/api-client";
import { astCacheApi, type AstCacheRebuildResult } from "@/lib/ast-cache-api";
import { Button } from "@/components/ui/button";

interface Props {
  projectId: string;
  repoId: string;
}

export function RebuildCacheButton({ projectId, repoId }: Props) {
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<AstCacheRebuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRebuild() {
    setPending(true);
    setResult(null);
    setError(null);
    try {
      const data = await astCacheApi.rebuild(projectId, repoId);
      setResult(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Cache rebuild failed");
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2" data-testid={`rebuild-cache-${repoId}`}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => void handleRebuild()}
        disabled={pending}
        data-testid={`rebuild-cache-button-${repoId}`}
        title="Rebuild the AST summary cache from the latest source"
      >
        {pending ? "Rebuilding…" : "Rebuild AST cache"}
      </Button>

      {!pending && result ? (
        <span
          className="text-xs text-emerald-600"
          role="status"
          aria-live="polite"
          data-testid={`rebuild-cache-status-${repoId}`}
        >
          Rebuilt: {result.stats.indexedFiles} file(s), {result.stats.totalSymbols} symbol(s),{" "}
          {result.stats.skippedFiles} skipped
        </span>
      ) : null}

      {!pending && error ? (
        <span
          className="text-xs text-destructive"
          role="alert"
          data-testid={`rebuild-cache-error-${repoId}`}
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
