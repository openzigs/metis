/**
 * Cross-document findings panel (Epic #203 / Issue #221).
 *
 * Renders the first-class cross-document conflict / contradiction /
 * completeness findings detected over the ingested customer documents. Splits
 * the unified findings list into contradictions and completeness gaps, each
 * with their evidence segment references.
 */
"use client";

import type {
  CrossDocFindingsSummary,
  CrossDocFindingSummary,
  ResolvedEvidenceRef,
} from "@/lib/analysis-api";
import { formatEvidenceRef } from "@/lib/format-evidence-ref";

const KIND_LABELS: Record<CrossDocFindingSummary["kind"], string> = {
  contradiction: "Contradiction",
  "missing-nfr": "Missing NFR",
  "missing-acceptance-criteria": "Missing acceptance criteria",
  "missing-assumption": "Missing assumption",
  "missing-risk": "Missing risk",
};

const SEVERITY_CLASS: Record<CrossDocFindingSummary["severity"], string> = {
  critical: "border-destructive/40 bg-destructive/10",
  high: "border-destructive/40 bg-destructive/10",
  medium: "border-warning/40 bg-warning-muted",
  low: "border-border/50 bg-muted/30",
  info: "border-border bg-muted/30",
};

/**
 * Issue #448 (epic #407) — render each evidence reference as a readable chip.
 *
 * `evidence` carries the server-resolved {@link ResolvedEvidenceRef}s (readable
 * source label + line); `ids` is the raw `evidenceIds` used both as the render
 * fallback (legacy / un-enriched payloads) and to fill out chips for any id the
 * server could not resolve. Every chip keeps its raw id in the `title` tooltip.
 */
function EvidenceRefs({ ids, evidence }: { ids: string[]; evidence?: ResolvedEvidenceRef[] }) {
  if (ids.length === 0) {
    return <span className="text-xs text-muted-foreground">No evidence references</span>;
  }

  // Index resolved refs by their raw id so each raw id renders at most one chip
  // (in the stable `ids` order), enriched when the server resolved it.
  const resolvedById = new Map((evidence ?? []).map((ref) => [ref.chunkId, ref]));

  return (
    <div className="mt-1 flex flex-wrap gap-1" data-testid="cross-doc-evidence">
      {ids.map((id) => {
        const resolved = resolvedById.get(id);
        const { label, title } = formatEvidenceRef(resolved ?? id);
        return (
          <span
            key={id}
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground"
            title={`Evidence: ${title}`}
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

function FindingCard({ finding }: { finding: CrossDocFindingSummary }) {
  return (
    <div
      className={`rounded border p-3 ${SEVERITY_CLASS[finding.severity]}`}
      data-testid={`cross-doc-finding-${finding.kind}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-medium text-foreground">{finding.title}</div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-foreground">
            {KIND_LABELS[finding.kind]}
          </span>
          {finding.scope ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {finding.scope}
            </span>
          ) : null}
        </div>
      </div>
      <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{finding.detail}</p>
      <EvidenceRefs ids={finding.evidenceIds} evidence={finding.evidence} />
    </div>
  );
}

export function CrossDocFindingsPanel({
  crossDocFindings,
}: {
  crossDocFindings: CrossDocFindingsSummary | null;
}) {
  if (!crossDocFindings || crossDocFindings.findings.length === 0) {
    return (
      <div data-testid="cross-doc-panel">
        <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Cross-document findings
        </h4>
        <p className="text-sm text-muted-foreground">
          No cross-document contradictions or completeness gaps detected.
        </p>
      </div>
    );
  }

  const contradictions = crossDocFindings.findings.filter((f) => f.kind === "contradiction");
  const gaps = crossDocFindings.findings.filter((f) => f.kind !== "contradiction");

  return (
    <div data-testid="cross-doc-panel">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Cross-document findings
        </h4>
        <span className="text-xs text-muted-foreground">
          {crossDocFindings.contradictionCount} contradiction
          {crossDocFindings.contradictionCount === 1 ? "" : "s"} ·{" "}
          {crossDocFindings.completenessGapCount} gap
          {crossDocFindings.completenessGapCount === 1 ? "" : "s"}
        </span>
      </div>

      {contradictions.length > 0 ? (
        <div className="mb-3 space-y-2">
          <h5 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Contradictions
          </h5>
          {contradictions.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      ) : null}

      {gaps.length > 0 ? (
        <div className="space-y-2">
          <h5 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Completeness gaps
          </h5>
          {gaps.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
