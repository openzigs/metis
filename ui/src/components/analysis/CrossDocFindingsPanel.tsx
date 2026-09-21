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
  critical: "border-red-700/60 bg-red-950/30",
  high: "border-red-700/50 bg-red-950/20",
  medium: "border-amber-700/50 bg-amber-950/20",
  low: "border-zinc-700/50 bg-zinc-900/30",
  info: "border-zinc-800 bg-zinc-900/30",
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
    return <span className="text-xs text-zinc-500">No evidence references</span>;
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
            className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
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
        <div className="text-sm font-medium text-zinc-100">{finding.title}</div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-300">
            {KIND_LABELS[finding.kind]}
          </span>
          {finding.scope ? (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
              {finding.scope}
            </span>
          ) : null}
        </div>
      </div>
      <p className="mt-1 whitespace-pre-line text-xs text-zinc-400">{finding.detail}</p>
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
        <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Cross-document findings
        </h4>
        <p className="text-sm text-zinc-500">
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
        <h4 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Cross-document findings
        </h4>
        <span className="text-xs text-zinc-500">
          {crossDocFindings.contradictionCount} contradiction
          {crossDocFindings.contradictionCount === 1 ? "" : "s"} ·{" "}
          {crossDocFindings.completenessGapCount} gap
          {crossDocFindings.completenessGapCount === 1 ? "" : "s"}
        </span>
      </div>

      {contradictions.length > 0 ? (
        <div className="mb-3 space-y-2">
          <h5 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
            Contradictions
          </h5>
          {contradictions.map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
        </div>
      ) : null}

      {gaps.length > 0 ? (
        <div className="space-y-2">
          <h5 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
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
