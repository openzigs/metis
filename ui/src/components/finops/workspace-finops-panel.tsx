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
import { finopsApi, formatCents } from "@/lib/finops-api";
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
