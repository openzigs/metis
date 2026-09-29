"use client";

/**
 * #31 — was the /admin/usage page; now the All-projects scope of Settings → Usage.
 *
 * Epic #594 / Issue #607 — Admin Usage Dashboard.
 *
 * Shows cross-project token usage, cost by model, top users, and time
 * range filtering with CSV export.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/tables/responsive-table";
import { PanelHeader } from "@/components/layout/panel-header";

interface UsageRow {
  dayBucket: string;
  provider: string;
  model: string;
  userId?: string;
  projectId?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** `null` when none of this group's usage was priced (#22). */
  estimatedCostUsd: number | null;
  unpricedTokens: number;
  count: number;
}

interface UsageSummary {
  totalTokens: number;
  /** Cost of the PRICED usage only — see `unpriced` (#22). */
  totalCostUsd: number;
  unpriced: { promptTokens: number; completionTokens: number; totalTokens: number; count: number };
  rows: UsageRow[];
}

async function fetchAdminUsage(range: string, groupBy: string): Promise<UsageSummary> {
  const res = await fetch(`/api/admin/usage?range=${range}&groupBy=${groupBy}`);
  if (!res.ok) throw new Error("Failed to load admin usage");
  const json = await res.json();
  return json.data;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

/** #22 — `null` is an UNPRICED model: unknown spend, never shown as $0. */
function formatCost(usd: number | null): string {
  return usd === null ? "Unpriced" : `$${usd.toFixed(4)}`;
}

const usageColumns: ResponsiveColumn<UsageRow>[] = [
  { key: "period", header: "Period", cell: (row) => row.dayBucket },
  { key: "model", header: "Model", cell: (row) => row.model, cellClassName: "font-mono text-xs" },
  { key: "input", header: "Input", align: "right", cell: (row) => formatTokens(row.promptTokens) },
  {
    key: "output",
    header: "Output",
    align: "right",
    cell: (row) => formatTokens(row.completionTokens),
  },
  { key: "total", header: "Total", align: "right", cell: (row) => formatTokens(row.totalTokens) },
  { key: "cost", header: "Cost", align: "right", cell: (row) => formatCost(row.estimatedCostUsd) },
  {
    key: "unpriced",
    header: "Unpriced tokens",
    align: "right",
    cell: (row) => formatTokens(row.unpricedTokens),
  },
];

export function PlatformUsagePanel() {
  const [range, setRange] = useState<string>("30d");
  const [groupBy, setGroupBy] = useState<string>("project");

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-usage", range, groupBy],
    queryFn: () => fetchAdminUsage(range, groupBy),
  });

  const handleExport = () => {
    window.open(`/api/admin/usage/csv?range=${range}&groupBy=${groupBy}`, "_blank");
  };

  return (
    <div className="space-y-6">
      <PanelHeader
        title="Token Usage Dashboard"
        actions={
          <div className="flex items-center gap-3">
            <select
              aria-label="Time range"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            >
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="90d">Last 90 days</option>
            </select>
            <select
              aria-label="Group by"
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value)}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-sm"
            >
              <option value="project">By Project</option>
              <option value="day">By Day</option>
              <option value="model">By Model</option>
              <option value="user">By User</option>
            </select>
            <button
              onClick={handleExport}
              className="rounded-md bg-info px-3 py-1.5 text-sm text-info-foreground hover:bg-info/90"
            >
              Export CSV
            </button>
          </div>
        }
      />

      {isLoading && <p className="text-muted-foreground">Loading usage data…</p>}
      {error && <p className="text-destructive">Error loading usage data</p>}

      {data && (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Total Tokens</p>
              <p className="text-2xl font-bold">{formatTokens(data.totalTokens)}</p>
            </Card>
            <Card className="p-4" data-testid="admin-usage-cost">
              <p className="text-sm text-muted-foreground">Estimated Cost</p>
              <p className="text-2xl font-bold">
                {/* PR #41 review — all-unpriced usage is not "$0.0000" of spend. */}
                {data.totalCostUsd === 0 && data.unpriced.totalTokens > 0
                  ? "Unpriced"
                  : formatCost(data.totalCostUsd)}
              </p>
            </Card>
            <Card className="p-4" data-testid="admin-usage-unpriced">
              <p className="text-sm text-muted-foreground">Unpriced Tokens</p>
              <p className="text-2xl font-bold">{formatTokens(data.unpriced.totalTokens)}</p>
              <p className="text-xs text-muted-foreground">
                {formatTokens(data.unpriced.promptTokens)} in /{" "}
                {formatTokens(data.unpriced.completionTokens)} out — not in the cost; set prices
                with MODEL_PRICES
              </p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-muted-foreground">Invocations</p>
              <p className="text-2xl font-bold">
                {data.rows.reduce((s, r) => s + r.count, 0).toLocaleString()}
              </p>
            </Card>
          </div>

          {/* Bar chart */}
          <Card className="p-4">
            <h2 className="mb-4 text-lg font-medium">Token Usage by {groupBy}</h2>
            <div className="flex items-end gap-1" style={{ height: 200 }}>
              {data.rows.length === 0 && (
                <p className="text-sm text-muted-foreground">No usage data for this period</p>
              )}
              {(() => {
                const maxTokens = Math.max(...data.rows.map((r) => r.totalTokens), 1);
                return data.rows.slice(0, 30).map((row, i) => {
                  const pct = (row.totalTokens / maxTokens) * 100;
                  const label =
                    groupBy === "day"
                      ? row.dayBucket.slice(5)
                      : groupBy === "model"
                        ? (row.model.split(".").pop()?.slice(0, 10) ?? row.model)
                        : groupBy === "user"
                          ? (row.userId ?? "").slice(0, 8)
                          : (row.projectId ?? "").slice(0, 8);
                  return (
                    <div key={i} className="flex flex-1 flex-col items-center gap-1">
                      <div
                        className="w-full rounded-t bg-info"
                        style={{ height: `${Math.max(pct, 2)}%` }}
                        title={`${formatTokens(row.totalTokens)} tokens / ${formatCost(row.estimatedCostUsd)}`}
                      />
                      <span className="text-[10px] text-muted-foreground truncate max-w-full">
                        {label}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
          </Card>

          {/* Table */}
          <Card className="overflow-x-auto p-4">
            <h2 className="mb-4 text-lg font-medium">Details</h2>
            <ResponsiveTable
              data={data.rows}
              getRowKey={(_row, index) => String(index)}
              ariaLabel="Usage details by period and model"
              columns={usageColumns}
            />
          </Card>
        </>
      )}
    </div>
  );
}
