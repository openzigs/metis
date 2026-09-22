"use client";

/**
 * Epic #164 — Per-project FinOps usage page.
 *
 * Renders three views:
 *   1. Headline tile — month-to-date tokens / cost / projection / budget.
 *   2. Tokens-per-day mini-chart — pure SVG, no chart library dependency.
 *   3. By-provider breakdown table.
 *   4. Recent SafetyEvent table from `/api/projects/:id/safety-events`.
 *
 * Re-fetches with TanStack Query and listens for the `usage:tick`
 * Socket.IO event (Phase 11 socket layer) to invalidate the rollup so the
 * UI reflects new traffic without polling.
 */
import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { projectsApi } from "@/lib/projects-api";
import { queryKeys } from "@/lib/query-keys";
import { Card } from "@/components/ui/card";

/** #22 — `null` is an UNPRICED model: unknown spend, never shown as $0. */
function formatCents(cents: number | null): string {
  if (cents === null) return "Unpriced";
  return `$${(cents / 100).toFixed(2)}`;
}

/** #22 — USD with the unpriced (`null`) case spelled out. */
function formatUsd(usd: number | null): string {
  return usd === null ? "unpriced" : `$${usd.toFixed(4)}`;
}

/** #22 — the note that keeps unpriced tokens out of the dollar figure, visibly. */
const UNPRICED_HINT =
  "Models with no configured price are not included in the cost. An administrator can set per-model prices with the MODEL_PRICES setting.";

function formatTokens(n: number): string {
  return n.toLocaleString();
}

export default function ProjectUsagePage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [range, setRange] = useState<string>("7d");
  const [groupBy, setGroupBy] = useState<string>("day");

  const projectQuery = useQuery({
    queryKey: queryKeys.projects.detail(id),
    queryFn: () => projectsApi.get(id),
    enabled: Boolean(id),
  });
  const usageQuery = useQuery({
    queryKey: queryKeys.projects.usage(id),
    queryFn: () => projectsApi.getUsage(id),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
  });
  const eventsQuery = useQuery({
    queryKey: queryKeys.projects.safetyEvents(id, { limit: 50 }),
    queryFn: () => projectsApi.getSafetyEvents(id, { limit: 50 }),
    enabled: Boolean(id),
    refetchOnWindowFocus: false,
  });
  const budgetQuery = useQuery({
    queryKey: ["project-budget", id],
    queryFn: () => projectsApi.getTokenBudget(id),
    enabled: Boolean(id),
  });
  const enhancedUsageQuery = useQuery({
    queryKey: ["project-enhanced-usage", id, range, groupBy],
    queryFn: () => projectsApi.getEnhancedUsage(id, { range, groupBy }),
    enabled: Boolean(id),
  });
  // Epic #596 / #620 — agent-step token breakdown
  const agentStepQuery = useQuery({
    queryKey: ["project-agent-step-usage", id, range],
    queryFn: () => projectsApi.getEnhancedUsage(id, { range, groupBy: "agentStep" }),
    enabled: Boolean(id),
  });

  if (!id) return <div className="p-6">Invalid project id.</div>;
  if (usageQuery.isLoading || projectQuery.isLoading) {
    return (
      <div className="p-6" data-testid="usage-loading">
        Loading…
      </div>
    );
  }
  if (usageQuery.error) {
    return (
      <div className="p-6 text-destructive" data-testid="usage-error" role="alert">
        Failed to load usage.
      </div>
    );
  }
  const u = usageQuery.data;
  const project = projectQuery.data;
  if (!u || !project) {
    return <div className="p-6">No usage data.</div>;
  }
  const budget = u.monthlyTokenBudget;
  const pctOfBudget =
    budget != null && budget > 0 ? Math.min(100, (u.monthToDateTokens / budget) * 100) : null;
  const overBudget = budget != null && u.monthToDateTokens >= budget;

  return (
    <div className="space-y-6 p-6" data-testid="usage-root">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Usage — {project.name}</h1>
          <p className="text-sm text-muted-foreground">
            Tokens and cost from {new Date(u.from).toLocaleDateString()} to{" "}
            {new Date(u.to).toLocaleDateString()}.
          </p>
        </div>
        <Link href={`/projects/${id}`} className="text-sm underline" data-testid="usage-back-link">
          ← Back to project
        </Link>
      </header>

      <section
        className="grid grid-cols-1 gap-3 md:grid-cols-4"
        aria-label="Usage headline"
        data-testid="usage-headline"
      >
        <Tile
          label="Tokens (window)"
          value={formatTokens(u.totalTokens)}
          testId="tile-window-tokens"
        />
        <Tile
          label="MTD tokens"
          value={formatTokens(u.monthToDateTokens)}
          testId="tile-mtd-tokens"
        />
        <Tile label="Window cost" value={formatCents(u.costCents)} testId="tile-window-cost" />
        <Tile
          label="Projected month"
          value={formatCents(u.projectedMonthlyCostCents)}
          testId="tile-projected-cost"
        />
      </section>

      {u.unpriced.totalTokens > 0 ? (
        <Card className="space-y-1 p-4" data-testid="usage-unpriced">
          <h2 className="text-sm font-semibold">Unpriced usage</h2>
          <p className="text-sm" data-testid="usage-unpriced-tokens">
            {formatTokens(u.unpriced.totalTokens)} tokens ({formatTokens(u.unpriced.inputTokens)}{" "}
            input / {formatTokens(u.unpriced.outputTokens)} output) across{" "}
            {u.unpriced.calls.toLocaleString()} call{u.unpriced.calls === 1 ? "" : "s"}.
          </p>
          <p className="text-xs text-muted-foreground">{UNPRICED_HINT}</p>
        </Card>
      ) : null}

      {budget != null ? (
        <Card className="space-y-2 p-4" data-testid="usage-budget-card">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold">Monthly token budget</h2>
            <span className="text-sm">
              {formatTokens(u.monthToDateTokens)} / {formatTokens(budget)}
            </span>
          </div>
          <div
            className="h-2 w-full overflow-hidden rounded bg-muted"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={budget}
            aria-valuenow={u.monthToDateTokens}
          >
            <div
              className={overBudget ? "h-full bg-destructive" : "h-full bg-primary"}
              style={{ width: `${pctOfBudget ?? 0}%` }}
              data-testid="usage-budget-bar"
            />
          </div>
          {overBudget ? (
            <p className="text-xs text-destructive" role="alert" data-testid="usage-over-budget">
              Over budget — provider calls return HTTP 402 until the cap is raised.
            </p>
          ) : null}
        </Card>
      ) : (
        <Card className="p-4 text-sm text-muted-foreground" data-testid="usage-no-budget">
          No monthly token budget configured.
        </Card>
      )}

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">Tokens per day</h2>
        {u.byDay.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="usage-by-day-empty">
            No usage in window.
          </p>
        ) : (
          <DayChart data={u.byDay} />
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">By provider</h2>
        {u.byProvider.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="usage-by-provider-empty">
            No usage in window.
          </p>
        ) : (
          <table className="w-full text-sm" data-testid="usage-by-provider-table">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1">Provider</th>
                <th className="py-1">Model</th>
                <th className="py-1 text-right">Input</th>
                <th className="py-1 text-right">Output</th>
                <th className="py-1 text-right">Total</th>
                <th className="py-1 text-right">Cost</th>
              </tr>
            </thead>
            <tbody>
              {u.byProvider.map((row) => (
                <tr key={`${row.provider}:${row.model}`} className="border-t">
                  <td className="py-1">{row.provider}</td>
                  <td className="py-1">{row.model}</td>
                  <td className="py-1 text-right">{formatTokens(row.inputTokens)}</td>
                  <td className="py-1 text-right">{formatTokens(row.outputTokens)}</td>
                  <td className="py-1 text-right">{formatTokens(row.totalTokens)}</td>
                  <td className="py-1 text-right" data-testid={`provider-cost-${row.model}`}>
                    {formatCents(row.costCents)}
                    {row.costCents !== null && row.unpricedTokens > 0
                      ? ` + ${formatTokens(row.unpricedTokens)} unpriced tokens`
                      : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="space-y-3 p-4" data-testid="morph-apply-card">
        <h2 className="text-sm font-semibold">Diff editing (morph apply)</h2>
        <MorphApplyPanel rows={u.byProvider} />
      </Card>

      {/* Epic #594 — Token Budget Gauge */}
      {budgetQuery.data && (
        <Card className="space-y-3 p-4" data-testid="token-budget-gauge">
          <h2 className="text-sm font-semibold">Token Budget Status</h2>
          <BudgetGauge status={budgetQuery.data.status} budget={budgetQuery.data.budget} />
        </Card>
      )}

      {/* Epic #594 — Enhanced Usage with time range filter */}
      <Card className="space-y-4 p-4" data-testid="enhanced-usage-section">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Detailed Usage Analytics</h2>
          <div className="flex items-center gap-2">
            <select
              value={range}
              onChange={(e) => setRange(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800"
              data-testid="usage-range-select"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              className="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs dark:border-gray-700 dark:bg-gray-800"
              data-testid="usage-groupby-select"
            >
              <option value="day">By Day</option>
              <option value="model">By Model</option>
              <option value="user">By User</option>
              <option value="agentStep">By Agent Step</option>
            </select>
            <button
              onClick={() => projectsApi.exportUsageCsv(id, { range, groupBy })}
              className="rounded-md bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700"
              data-testid="usage-csv-export"
            >
              Export CSV
            </button>
          </div>
        </div>

        {enhancedUsageQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading detailed usage…</p>
        )}
        {enhancedUsageQuery.data && (enhancedUsageQuery.data.rows?.length ?? 0) > 0 && (
          <>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <p className="text-xs text-muted-foreground">Total Tokens</p>
                <p className="text-lg font-semibold">
                  {formatTokens(enhancedUsageQuery.data.totalTokens)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Estimated Cost</p>
                <p className="text-lg font-semibold">
                  ${enhancedUsageQuery.data.totalCostUsd.toFixed(4)}
                </p>
              </div>
              <div data-testid="enhanced-unpriced">
                <p className="text-xs text-muted-foreground" title={UNPRICED_HINT}>
                  Unpriced Tokens
                </p>
                <p className="text-lg font-semibold">
                  {formatTokens(enhancedUsageQuery.data.unpriced.totalTokens)}
                </p>
              </div>
            </div>

            {/* CSS bar chart */}
            <div
              className="flex items-end gap-1"
              style={{ height: 120 }}
              data-testid="enhanced-bar-chart"
            >
              {(() => {
                const maxTokens = Math.max(
                  ...enhancedUsageQuery.data.rows.map((r) => r.totalTokens),
                  1,
                );
                return enhancedUsageQuery.data.rows.slice(0, 30).map((row, i) => {
                  const pct = (row.totalTokens / maxTokens) * 100;
                  const label =
                    groupBy === "day"
                      ? row.dayBucket.slice(5)
                      : groupBy === "model"
                        ? (row.model.split(".").pop()?.slice(0, 10) ?? row.model)
                        : (row.userId ?? "").slice(0, 8);
                  return (
                    <div key={i} className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className="w-full rounded-t bg-blue-500"
                        style={{ height: `${Math.max(pct, 2)}%` }}
                        title={`${formatTokens(row.totalTokens)} tokens / ${formatUsd(row.estimatedCostUsd)}`}
                      />
                      <span className="text-[10px] text-gray-500 truncate max-w-full">{label}</span>
                    </div>
                  );
                });
              })()}
            </div>
          </>
        )}
        {enhancedUsageQuery.data && (enhancedUsageQuery.data.rows?.length ?? 0) === 0 && (
          <p className="text-sm text-muted-foreground">No usage data for this period</p>
        )}
      </Card>

      {/* Epic #596 / #620 — Agent-Level Token Breakdown */}
      <Card className="space-y-3 p-4" data-testid="agent-step-breakdown">
        <h2 className="text-sm font-semibold">Token Usage by Agent Step</h2>
        {agentStepQuery.isLoading && (
          <p className="text-sm text-muted-foreground">Loading agent breakdown…</p>
        )}
        {agentStepQuery.data && (agentStepQuery.data.rows?.length ?? 0) > 0 ? (
          <AgentStepChart rows={agentStepQuery.data.rows} total={agentStepQuery.data.totalTokens} />
        ) : (
          !agentStepQuery.isLoading && (
            <p className="text-sm text-muted-foreground" data-testid="agent-step-empty">
              No agent step data for this period.
            </p>
          )
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-semibold">Recent safety events</h2>
        {eventsQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : eventsQuery.data && eventsQuery.data.items.length > 0 ? (
          <table className="w-full text-sm" data-testid="safety-events-table">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1">When</th>
                <th className="py-1">Direction</th>
                <th className="py-1">Verdict</th>
                <th className="py-1">Findings</th>
              </tr>
            </thead>
            <tbody>
              {eventsQuery.data.items.map((ev) => (
                <tr key={ev.id} className="border-t" data-testid={`safety-event-row-${ev.verdict}`}>
                  <td className="py-1">{new Date(ev.createdAt).toLocaleString()}</td>
                  <td className="py-1">{ev.direction}</td>
                  <td className="py-1">
                    <VerdictBadge verdict={ev.verdict} />
                  </td>
                  <td className="py-1 text-xs text-muted-foreground">
                    {ev.findings.length === 0
                      ? "—"
                      : ev.findings
                          .map((f) => `${f.kind}${f.count ? ` × ${f.count}` : ""}`)
                          .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="safety-events-empty">
            No safety events in window.
          </p>
        )}
      </Card>
    </div>
  );
}

function Tile({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <Card className="p-3" data-testid={testId}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight">{value}</p>
    </Card>
  );
}

function VerdictBadge({ verdict }: { verdict: "allowed" | "blocked" | "redacted" }) {
  const map: Record<typeof verdict, string> = {
    allowed: "bg-emerald-100 text-emerald-900",
    blocked: "bg-rose-100 text-rose-900",
    redacted: "bg-amber-100 text-amber-900",
  };
  return (
    <span
      className={`rounded px-2 py-0.5 text-xs ${map[verdict]}`}
      data-testid={`verdict-badge-${verdict}`}
    >
      {verdict}
    </span>
  );
}

function DayChart({ data }: { data: Array<{ day: string; totalTokens: number }> }) {
  const W = 600;
  const H = 120;
  const PAD = 8;
  const max = Math.max(1, ...data.map((d) => d.totalTokens));
  const innerW = W - PAD * 2;
  const innerH = H - PAD * 2;
  const bw = innerW / Math.max(1, data.length);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-32 w-full"
      role="img"
      aria-label="Tokens per day"
      data-testid="usage-by-day-chart"
    >
      {data.map((d, i) => {
        const h = (d.totalTokens / max) * innerH;
        const x = PAD + i * bw;
        const y = PAD + (innerH - h);
        return (
          <g key={d.day}>
            <rect
              x={x + 1}
              y={y}
              width={Math.max(2, bw - 2)}
              height={h}
              className="fill-primary"
              data-testid={`day-bar-${d.day}`}
            />
          </g>
        );
      })}
    </svg>
  );
}

interface ProviderRow {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number | null;
}

/**
 * Epic #195 — surface morph-apply token + cost rollup.
 * Filters provider rows by `model` prefix `morph:` (the cost-cap codebase
 * stores morph apply usage as provider=openai/model=morph:<id>).
 */
function MorphApplyPanel({ rows }: { rows: ProviderRow[] }) {
  const morphRows = rows.filter((r) => r.model.startsWith("morph:"));
  const totalTokens = morphRows.reduce((acc, r) => acc + r.totalTokens, 0);
  // #22 — priced cost only; an unpriced morph model contributes no dollars.
  const totalCost = morphRows.reduce((acc, r) => acc + (r.costCents ?? 0), 0);
  if (morphRows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="morph-apply-empty">
        No morph-apply usage in window.
      </p>
    );
  }
  return (
    <div className="space-y-3" data-testid="morph-apply-summary">
      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-xs text-muted-foreground">Calls</p>
          <p className="text-lg font-semibold" data-testid="morph-apply-calls">
            {morphRows.length.toLocaleString()}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Tokens</p>
          <p className="text-lg font-semibold" data-testid="morph-apply-tokens">
            {totalTokens.toLocaleString()}
          </p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Cost</p>
          <p className="text-lg font-semibold" data-testid="morph-apply-cost">
            {(totalCost / 100).toLocaleString(undefined, {
              style: "currency",
              currency: "USD",
            })}
          </p>
        </div>
      </div>
      <ul className="space-y-1 text-xs text-muted-foreground" data-testid="morph-apply-models">
        {morphRows.map((r) => (
          <li key={r.model}>
            <span className="font-mono">{r.model}</span> — {r.totalTokens.toLocaleString()} tokens
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Epic #594 — Budget gauge component showing current utilization, soft
 * threshold warnings, and hard limit alerts.
 */
function BudgetGauge({
  status,
  budget,
}: {
  status: {
    allowed: boolean;
    remainingTokens: number;
    percentUsed: number;
    shouldDowngrade: boolean;
    message: string | null;
  };
  budget: {
    dailyTokenLimit: number | null;
    monthlyTokenLimit: number | null;
    downgradeModel: string | null;
  } | null;
}) {
  if (!budget) {
    return <p className="text-sm text-muted-foreground">No budget configured for this project.</p>;
  }

  const pct = Math.min(status.percentUsed * 100, 100);
  const barColor = !status.allowed
    ? "bg-red-500"
    : status.shouldDowngrade
      ? "bg-amber-500"
      : "bg-emerald-500";

  return (
    <div className="space-y-2" data-testid="budget-gauge-inner">
      <div className="flex items-baseline justify-between text-sm">
        <span>{Math.round(pct)}% used</span>
        <span className="text-muted-foreground">
          {status.remainingTokens === Infinity
            ? "No limit"
            : `${status.remainingTokens.toLocaleString()} remaining`}
        </span>
      </div>
      <div
        className="h-3 w-full overflow-hidden rounded bg-muted"
        role="progressbar"
        aria-valuenow={pct}
      >
        <div className={`h-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      {status.message && (
        <p className={`text-xs ${!status.allowed ? "text-red-600" : "text-amber-600"}`}>
          {status.message}
        </p>
      )}
      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        {budget.dailyTokenLimit && (
          <span>Daily limit: {budget.dailyTokenLimit.toLocaleString()}</span>
        )}
        {budget.monthlyTokenLimit && (
          <span>Monthly limit: {budget.monthlyTokenLimit.toLocaleString()}</span>
        )}
        {budget.downgradeModel && <span>Downgrade model: {budget.downgradeModel}</span>}
      </div>
    </div>
  );
}

/**
 * Epic #596 / #620 — Agent-step token breakdown horizontal bar chart.
 */
interface AgentStepRow {
  agentStep?: string;
  totalTokens: number;
  estimatedCostUsd: number | null;
}
const STEP_COLORS = [
  "bg-blue-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-purple-500",
  "bg-rose-500",
  "bg-cyan-500",
  "bg-indigo-500",
  "bg-orange-500",
];
function AgentStepChart({ rows, total }: { rows: AgentStepRow[]; total: number }) {
  const sorted = [...rows].sort((a, b) => b.totalTokens - a.totalTokens);
  const maxTokens = Math.max(...sorted.map((r) => r.totalTokens), 1);
  return (
    <div className="space-y-2" data-testid="agent-step-chart">
      {sorted.map((row, i) => {
        const pct = (row.totalTokens / maxTokens) * 100;
        const label = row.agentStep ?? "unknown";
        const share = total > 0 ? ((row.totalTokens / total) * 100).toFixed(1) : "0";
        return (
          <div key={label} className="space-y-1">
            <div className="flex items-baseline justify-between text-xs">
              <span className="font-medium truncate max-w-[60%]">{label}</span>
              <span className="text-muted-foreground">
                {row.totalTokens.toLocaleString()} tokens ({share}%) ·{" "}
                {formatUsd(row.estimatedCostUsd)}
              </span>
            </div>
            <div className="h-3 w-full overflow-hidden rounded bg-muted">
              <div
                className={`h-full rounded ${STEP_COLORS[i % STEP_COLORS.length]}`}
                style={{ width: `${Math.max(pct, 1)}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
