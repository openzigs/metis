"use client";

/**
 * Issue #739 (Epic #727) — per-requirement analysis-depth indicator on the
 * analysis results page.
 *
 * When the escalation policy is enabled, each extracted requirement is scored for
 * ambiguity + impact (blast-radius size) and high scorers are routed to a deeper
 * multi-hop agentic pass. This panel surfaces that decision: a "deep analysis"
 * badge on the escalated requirements, a "standard" badge on the rest, and a
 * tooltip explaining WHY (the ambiguity/impact score breakdown). A one-line
 * summary counts deep vs standard requirements.
 *
 * Renders nothing when there is no escalation decision (policy disabled / plain
 * runs / pre-#739 runs), so it never adds noise to a standard analysis.
 */
import type { AnalysisEscalation, RequirementEscalation } from "@/lib/analysis-api";

interface Props {
  escalation: AnalysisEscalation | null;
}

/** A deep requirement gets an accent badge; a standard one a muted badge. */
function depthBadgeClass(depth: RequirementEscalation["depth"]): string {
  return depth === "deep"
    ? "bg-amber-900/40 text-amber-300 border-amber-700/50"
    : "bg-zinc-800 text-zinc-400 border-zinc-700";
}

/** Human-readable tooltip explaining a requirement's escalation decision. */
function scoreTooltip(r: RequirementEscalation): string {
  return [
    `score ${r.score.toFixed(2)}`,
    `ambiguity ${r.ambiguityScore.toFixed(2)}`,
    `impact ${r.impactScore.toFixed(2)} (${r.blastRadiusSize} symbol${
      r.blastRadiusSize === 1 ? "" : "s"
    })`,
  ].join(" · ");
}

export function AnalysisDepthPanel({ escalation }: Props): React.ReactElement | null {
  const requirements = escalation?.requirements ?? [];
  if (!escalation || requirements.length === 0) return null;

  const deepCount = requirements.filter((r) => r.depth === "deep").length;
  const standardCount = requirements.length - deepCount;

  return (
    <div data-testid="analysis-depth-panel" className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
        Analysis depth
      </h4>
      <p className="text-xs text-zinc-500" data-testid="analysis-depth-summary">
        {deepCount} deep · {standardCount} standard. High-ambiguity / high-impact requirements
        (score ≥ {escalation.threshold.toFixed(2)}) received a deeper multi-hop pass.
      </p>
      <ul className="space-y-1.5">
        {requirements.map((r) => (
          <li
            key={r.requirementId}
            data-testid={`analysis-depth-req-${r.requirementId}`}
            className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-900/30 p-2 text-xs"
          >
            <span
              data-testid={`analysis-depth-badge-${r.requirementId}`}
              title={scoreTooltip(r)}
              className={`rounded border px-1.5 py-0.5 font-medium ${depthBadgeClass(r.depth)}`}
            >
              {r.depth === "deep" ? "deep analysis" : "standard"}
            </span>
            <span className="font-mono text-zinc-500">{r.requirementId}</span>
            <span className="flex-1 text-zinc-300">{r.text}</span>
            <span className="text-zinc-500" title={scoreTooltip(r)}>
              {r.score.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
