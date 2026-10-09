"use client";

/**
 * #31 — was /workspaces/:id/finops; now the Workspace scope of Settings → Usage.
 *
 * Workspace FinOps page (Epic #47 / Issue #54).
 *
 * Surfaces the spend forecast chart, the budget config form, the alert rule
 * editor, the alert-channel + alert-event log, a per-project forecast
 * drill-in, and the monthly chargeback PDF download.
 *
 * NOTE: the issue AC mentions Playwright e2e covering the sub-features; e2e
 * was intentionally deferred (orchestrator instruction). The interactive
 * pieces are covered by component/hook unit tests instead.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { finopsApi, formatCents, type WorkspaceUsageTotals } from "@/lib/finops-api";
import { ForecastChart } from "@/components/finops/ForecastChart";
import { BudgetForm } from "@/components/finops/BudgetForm";
import { AlertRuleEditor } from "@/components/finops/AlertRuleEditor";
import { PanelHeader } from "@/components/layout/panel-header";

export function WorkspaceFinopsPanel({ workspaceId }: { workspaceId: string }) {
  const [projectId, setProjectId] = useState<string>("");

  const budgetQuery = useQuery({
    queryKey: ["finops", workspaceId, "budget"],
    queryFn: () => finopsApi.getBudget(workspaceId),
  });

  const forecastQuery = useQuery({
    queryKey: ["finops", workspaceId, "forecast", projectId || "workspace"],
    queryFn: () => finopsApi.getForecast(workspaceId, projectId || undefined),
  });

  const eventsQuery = useQuery({
    queryKey: ["finops", workspaceId, "events"],
    queryFn: () => finopsApi.getEvents(workspaceId),
  });

  // #977 — what the workspace has actually spent this month.
  const totalsQuery = useQuery({
    queryKey: ["finops", workspaceId, "usage-totals"],
    queryFn: () => finopsApi.getUsageTotals(workspaceId),
  });

  const budgetCents = budgetQuery.data?.monthlyBudgetCents ?? null;
  const forecast = forecastQuery.data?.forecast ?? null;
  const events = eventsQuery.data?.events ?? [];

  return (
    <div className="space-y-6">
      <PanelHeader
        title="FinOps"
        actions={
          <a
            href={finopsApi.chargebackPdfUrl(workspaceId)}
            className="rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
            download
          >
            Download Chargeback PDF
          </a>
        }
      />

      {totalsQuery.data ? <WorkspaceUsageTiles totals={totalsQuery.data} /> : null}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <label htmlFor="project-scope" className="text-xs text-muted-foreground">
              Project:
            </label>
            <input
              id="project-scope"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="workspace (enter a project id to drill in)"
              className="flex-1 rounded border bg-background px-2 py-1 text-xs"
            />
          </div>
          <ForecastChart forecast={forecast} budgetCents={budgetCents} />
        </div>
        <BudgetForm workspaceId={workspaceId} currentBudgetCents={budgetCents} />
      </div>

      <AlertRuleEditor workspaceId={workspaceId} />

      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold">Recent Alerts</h3>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">No alerts fired yet.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex justify-between border-b py-1">
                <span>
                  {(e.ratio * 100).toFixed(0)}% of budget ({e.basis})
                </span>
                <span className="font-mono text-muted-foreground">
                  {formatCents(e.spendCents)} / {formatCents(e.budgetCents)} ·{" "}
                  {new Date(e.firedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * #977 — month-to-date token and cost totals for the workspace. Cost is the
 * ledger's unrounded USD, rounded here for display; unpriced usage is named
 * beside it, never counted as $0 (#22).
 */
export function WorkspaceUsageTiles({
  totals,
}: {
  totals: WorkspaceUsageTotals;
}): React.ReactElement {
  const cost =
    totals.costUsd === null
      ? "Unpriced"
      : `$${totals.costUsd.toFixed(2)}` +
        (totals.unpricedTokens > 0
          ? ` + ${totals.unpricedTokens.toLocaleString()} unpriced tokens`
          : "");
  return (
    <div className="grid gap-3 sm:grid-cols-3" data-testid="workspace-usage-totals">
      <div className="rounded-lg border bg-card p-3">
        <p className="text-xs text-muted-foreground">Tokens this month</p>
        <p className="text-lg font-semibold" data-testid="workspace-usage-tokens">
          {totals.totalTokens.toLocaleString()}
        </p>
      </div>
      <div className="rounded-lg border bg-card p-3">
        <p className="text-xs text-muted-foreground">Cost this month</p>
        <p className="text-lg font-semibold" data-testid="workspace-usage-cost">
          {cost}
        </p>
      </div>
      <div className="rounded-lg border bg-card p-3">
        <p className="text-xs text-muted-foreground">Model calls</p>
        <p className="text-lg font-semibold" data-testid="workspace-usage-calls">
          {totals.calls.toLocaleString()}
        </p>
      </div>
    </div>
  );
}
