"use client";

/**
 * Epic #594 / Issue #607 — Admin Usage Dashboard.
 *
 * Shows cross-project token usage, cost by model, top users, and time
 * range filtering with CSV export.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/tables/responsive-table";

interface UsageRow {
  dayBucket: string;
  provider: string;
  model: string;
  userId?: string;
  projectId?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  count: number;
}

interface UsageSummary {
  totalTokens: number;
  totalCostUsd: number;
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

function formatCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
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
];

export default function AdminUsagePage() {
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
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Token Usage Dashboard</h1>
        <div className="flex items-center gap-3">
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="90d">Last 90 days</option>
          </select>
          <select
            value={groupBy}
            onChange={(e) => setGroupBy(e.target.value)}
            className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
          >
            <option value="project">By Project</option>
            <option value="day">By Day</option>
            <option value="model">By Model</option>
            <option value="user">By User</option>
          </select>
          <button
            onClick={handleExport}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
          >
            Export CSV
          </button>
        </div>
      </div>

      {isLoading && <p className="text-gray-500">Loading usage data…</p>}
      {error && <p className="text-red-500">Error loading usage data</p>}

      {data && (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card className="p-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">Total Tokens</p>
              <p className="text-2xl font-bold">{formatTokens(data.totalTokens)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">Estimated Cost</p>
              <p className="text-2xl font-bold">{formatCost(data.totalCostUsd)}</p>
            </Card>
            <Card className="p-4">
              <p className="text-sm text-gray-500 dark:text-gray-400">Invocations</p>
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
                <p className="text-sm text-gray-400">No usage data for this period</p>
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
                        className="w-full rounded-t bg-blue-500"
                        style={{ height: `${Math.max(pct, 2)}%` }}
                        title={`${formatTokens(row.totalTokens)} tokens / ${formatCost(row.estimatedCostUsd)}`}
                      />
                      <span className="text-[10px] text-gray-500 truncate max-w-full">{label}</span>
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
