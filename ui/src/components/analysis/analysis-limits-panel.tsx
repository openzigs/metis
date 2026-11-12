"use client";

/**
 * Issue #2233 — what this run's limits left out.
 *
 * Two steps of an analysis read at most a fixed number of requirements
 * (retrieval for the code agent when there is no code graph, and the
 * governing-rule applicability check), and one agent answer keeps at most 50
 * findings. Before #2233 both cut in silence: a 41-requirement FRD was analysed
 * as 24 and the run read as complete. This panel says "analyzed 24 of 41" and
 * names every requirement and finding that was left out. It renders nothing on
 * a run where no limit was reached.
 */
import {
  readFindingsLeftOut,
  readRequirementsLeftOut,
  type AnalysisCapability,
  type RequirementLimitStage,
} from "@metis/shared";

interface Props {
  capability: AnalysisCapability | null;
}

/** The step each limit belongs to, in the analyst's words. */
const STAGE_TEXT: Record<RequirementLimitStage, string> = {
  "requirement-grounded-code": "searched for evidence and checked against the code",
  "governing-applicability": "checked against the governing rules",
  // #2276 — only the meaning-based half of the code search; keyword search read them all.
  "fused-code-semantic": "by meaning in the code search (the keyword search read all of them)",
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function AnalysisLimitsPanel({ capability }: Props): React.ReactElement | null {
  // #2276 — the stored record is unchecked JSON: a malformed entry is skipped, not rendered.
  const requirements = readRequirementsLeftOut(capability?.requirementsLeftOut);
  const findings = readFindingsLeftOut(capability?.findingsLeftOut);
  if (requirements.length === 0 && findings.length === 0) return null;

  return (
    <div data-testid="analysis-limits-panel" className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Analysis limits
      </h4>

      {requirements.map((n) => (
        <div key={n.stage} data-testid={`requirements-left-out-${n.stage}`} className="space-y-1">
          <p className="text-xs text-warning">
            Analyzed {n.analysedCount} of {plural(n.totalCount, "requirement", "requirements")}{" "}
            {STAGE_TEXT[n.stage]}.{" "}
            {plural(n.leftOut.length, "requirement was", "requirements were")} left out:
          </p>
          <ul className="space-y-1">
            {n.leftOut.map((r) => (
              <li key={r.id} className="text-xs text-warning">
                <span className="font-mono">{r.id}</span> <span>“{r.excerpt}”</span>
              </li>
            ))}
          </ul>
        </div>
      ))}

      {findings.map((n, i) => (
        <div
          key={`${n.agentKey}-${i}`}
          data-testid={`findings-left-out-${n.agentKey}`}
          className="space-y-1"
        >
          <p className="text-xs text-warning">
            The <span className="font-mono">{n.agentKey}</span> agent wrote{" "}
            {plural(n.producedCount, "finding", "findings")}; the first {n.keptCount} were kept and{" "}
            {plural(n.producedCount - n.keptCount, "was", "were")} not saved:
          </p>
          <ul className="space-y-1">
            {n.leftOutTitles.map((title, j) => (
              <li key={j} className="text-xs text-warning">
                “{title}”
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
