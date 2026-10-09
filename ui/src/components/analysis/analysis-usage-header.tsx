/**
 * #977 — the usage figures on the analysis page, labelled for what they are.
 *
 *   • {@link ProjectBudgetCard} — THIS project's month-to-date tokens and cost
 *     against its own monthly token budget (`Project.monthlyTokenBudget`, the
 *     cap provider calls are refused at). The header used to show only the
 *     deployment-wide analysis cap ("1.53M / 5.00M") next to a project that
 *     had a budget of its own.
 *   • {@link DeploymentCapCard} — that deployment-wide cap, now said to be.
 *   • {@link runSpendLabel} — a run's tokens and cost from the ledger, which
 *     move while it runs; `totalTokens` is written only when it finishes, so
 *     a running analysis read "0 tok" throughout.
 */
import type { AnalysisSnapshot, AnalysisCostCapStatus } from "@/lib/analysis-api";
import type { UsageSummary } from "@/lib/projects-api";

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Unrounded USD, rounded only here: four places, because one analysis call is
 * a fraction of a cent and two places would read $0.00.
 */
export function formatRunUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

const CARD = "rounded border border-border bg-muted/40 px-3 py-2 text-xs";

export function ProjectBudgetCard({ usage }: { usage: UsageSummary }): React.ReactElement {
  const budget = usage.monthlyTokenBudget;
  const used = usage.monthToDateTokens;
  const over = budget !== null && used >= budget;
  return (
    <div className={CARD} data-testid="analysis-project-budget">
      <div className="text-muted-foreground">This project, this month</div>
      <div className="font-mono" data-testid="analysis-project-budget-tokens">
        {budget !== null
          ? `${formatTokens(used)} / ${formatTokens(budget)} tokens`
          : `${formatTokens(used)} tokens · no project budget`}
      </div>
      <div className="font-mono text-muted-foreground" data-testid="analysis-project-budget-cost">
        {`$${(usage.costCents / 100).toFixed(2)}`}
        {usage.unpriced.totalTokens > 0
          ? ` + ${formatTokens(usage.unpriced.totalTokens)} unpriced tokens`
          : ""}
      </div>
      {over ? <div className="text-destructive">project budget reached</div> : null}
    </div>
  );
}

export function DeploymentCapCard({ cap }: { cap: AnalysisCostCapStatus }): React.ReactElement {
  return (
    <div
      className={CARD}
      data-testid="analysis-deployment-cap"
      title="The analysis token cap for this whole deployment, shared by every project."
    >
      <div className="text-muted-foreground">Deployment-wide analysis cap (all projects)</div>
      <div className="font-mono">
        {formatTokens(cap.monthlyUsed)} /{" "}
        {cap.monthlyCap === 0 ? "∞" : formatTokens(cap.monthlyCap)}
      </div>
      {cap.exceeded ? <div className="text-destructive">cap exceeded</div> : null}
    </div>
  );
}

/**
 * "41.0k tok · $0.0123" for a run. Tokens are the ledger's once it has any —
 * the live figure — and the run's own `totalTokens` before that (a run from
 * before analysis spend was metered, #724). Cost is the ledger's only.
 */
export function runSpendLabel(run: Pick<AnalysisSnapshot, "totalTokens" | "ledgerUsage">): string {
  const ledger = run.ledgerUsage;
  const tokens = ledger && ledger.totalTokens > 0 ? ledger.totalTokens : run.totalTokens;
  const parts = [`${formatTokens(tokens)} tok`];
  if (ledger && ledger.totalTokens > 0) {
    if (ledger.costUsd === null) parts.push("unpriced");
    else {
      parts.push(
        ledger.unpricedTokens > 0
          ? `${formatRunUsd(ledger.costUsd)} + ${formatTokens(ledger.unpricedTokens)} unpriced tok`
          : formatRunUsd(ledger.costUsd),
      );
    }
  }
  return parts.join(" · ");
}
