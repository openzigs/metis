"use client";

/**
 * Requirement → Spec → Code traceability view (Epic #207, issue #229).
 *
 * Read-only visualization of the full traceability chain for a single
 * requirement: the specs it satisfies and, under each, the code that implements
 * the spec, plus the direct requirement→code spine (#159). Loading / empty /
 * error states are handled and every confidence is surfaced as a badge.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  RequirementTraceabilityChain,
  TraceabilityCodeNode,
  TraceabilitySpecNode,
} from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { traceabilityApi } from "@/lib/traceability-api";
import { Badge } from "@/components/ui/badge";

export interface TraceabilityViewProps {
  projectId: string;
  requirementId: string;
}

export function traceabilityKey(projectId: string, requirementId: string) {
  return ["traceability-chain", projectId, requirementId] as const;
}

/** Render a 0–1 confidence as a percentage badge. */
function ConfidenceBadge({ confidence }: { confidence: number }): React.ReactElement {
  const pct = Math.round(confidence * 100);
  const low = confidence < 0.4;
  return <Badge variant={low ? "outline" : "secondary"}>{pct}%</Badge>;
}

/** Compose a `file:start-end` location string. */
function codeLocation(c: TraceabilityCodeNode): string {
  if (c.startLine == null) return c.filePath;
  return c.endLine != null && c.endLine !== c.startLine
    ? `${c.filePath}:${c.startLine}-${c.endLine}`
    : `${c.filePath}:${c.startLine}`;
}

function CodeRow({ c }: { c: TraceabilityCodeNode }): React.ReactElement {
  return (
    <li
      data-testid="traceability-code-row"
      className="flex items-center justify-between gap-2 py-1 pl-4 text-sm"
    >
      <code className="truncate font-mono text-xs">{codeLocation(c)}</code>
      <ConfidenceBadge confidence={c.confidence} />
    </li>
  );
}

function SpecBlock({ spec }: { spec: TraceabilitySpecNode }): React.ReactElement {
  return (
    <div data-testid="traceability-spec" className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{spec.specTitle ?? "(untitled spec)"}</span>
        <ConfidenceBadge confidence={spec.confidence} />
      </div>
      {spec.code.length > 0 ? (
        <ul className="mt-2">
          {spec.code.map((c, i) => (
            <CodeRow key={`${c.filePath}-${c.codeSymbolId ?? i}`} c={c} />
          ))}
        </ul>
      ) : (
        <p className="mt-2 pl-4 text-sm text-muted-foreground">No code linked to this spec yet.</p>
      )}
    </div>
  );
}

export function TraceabilityView({
  projectId,
  requirementId,
}: TraceabilityViewProps): React.ReactElement {
  const query = useQuery<RequirementTraceabilityChain>({
    queryKey: traceabilityKey(projectId, requirementId),
    queryFn: () => traceabilityApi.chain(projectId, requirementId),
    enabled: Boolean(projectId && requirementId),
  });

  if (query.isLoading) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading traceability…
      </p>
    );
  }

  if (query.isError) {
    const msg =
      query.error instanceof ApiError ? query.error.message : "Failed to load traceability";
    return (
      <p role="alert" className="text-sm text-destructive">
        {msg}
      </p>
    );
  }

  const chain = query.data;
  if (!chain) return <></>;

  const hasAnything = chain.specs.length > 0 || chain.directCode.length > 0;

  return (
    <section aria-label="Requirement traceability" className="space-y-4">
      <header>
        <h3 className="text-base font-semibold">{chain.requirementTitle}</h3>
        <p className="text-xs text-muted-foreground">Requirement → Spec → Code</p>
      </header>

      {!hasAnything && (
        <p data-testid="traceability-empty" className="text-sm text-muted-foreground">
          No specs or code are linked to this requirement yet. Run the backfill or add links
          manually.
        </p>
      )}

      {chain.specs.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-sm font-medium">Specs ({chain.specs.length})</h4>
          {chain.specs.map((s) => (
            <SpecBlock key={s.specDocumentId} spec={s} />
          ))}
        </div>
      )}

      {chain.directCode.length > 0 && (
        <div className="space-y-1">
          <h4 className="text-sm font-medium">Direct code links ({chain.directCode.length})</h4>
          <ul className="rounded-md border p-2">
            {chain.directCode.map((c, i) => (
              <CodeRow key={`${c.filePath}-${c.codeSymbolId ?? i}`} c={c} />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
