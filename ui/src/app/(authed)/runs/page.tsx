"use client";

/**
 * Epic #158 — /runs index page.
 *
 * Lists agent runs (replay timeline parents) with project + session filters
 * and a from/to date range. Click a row to drill into the timeline view.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SkeletonText } from "@/components/ui/skeleton";
import {
  ResponsiveTable,
  touchTargetClass,
  type ResponsiveColumn,
} from "@/components/tables/responsive-table";
import { runsApi, type AgentRunListFilters, type AgentRunSummary } from "@/lib/runs-api";

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "text-green-600";
    case "failed":
      return "text-red-600";
    case "cancelled":
      return "text-amber-600";
    default:
      return "text-blue-600";
  }
}

const runColumns: ResponsiveColumn<AgentRunSummary>[] = [
  {
    key: "started",
    header: "Started",
    cell: (r) => (
      <Link
        href={`/runs/${r.id}`}
        className={`${touchTargetClass} text-blue-600 underline-offset-2 hover:underline`}
      >
        {formatTimestamp(r.startedAt)}
      </Link>
    ),
  },
  { key: "kind", header: "Kind", cell: (r) => r.kind },
  {
    key: "status",
    header: "Status",
    cell: (r) => <span className={`font-medium ${statusClass(r.status)}`}>{r.status}</span>,
  },
  { key: "steps", header: "Steps", cell: (r) => r.stepCount },
  { key: "latency", header: "Latency", cell: (r) => (r.latencyMs ? `${r.latencyMs} ms` : "—") },
  { key: "tokens", header: "Tokens", cell: (r) => r.totalTokens ?? "—" },
  {
    key: "cost",
    header: "Cost",
    // Show a dollar amount only when cost has actually been attributed
    // (costCents > 0). A run that consumed tokens but has costCents === 0 is
    // unattributed (run-finish never aggregates TokenUsage cost into
    // AgentRun.costCents), so show "—" rather than a misleading "$0.0000".
    cell: (r) =>
      r.costCents != null && r.costCents > 0 ? `$${(r.costCents / 100).toFixed(4)}` : "—",
  },
];

export default function RunsPage() {
  const [filters, setFilters] = useState<AgentRunListFilters>({});

  const queryFilters = useMemo<AgentRunListFilters>(() => ({ ...filters }), [filters]);

  const runs = useQuery({
    queryKey: ["runs", queryFilters],
    queryFn: () => runsApi.list(queryFilters),
  });

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="runs-page">
      <div>
        <h1 className="text-2xl font-semibold">Agent Runs</h1>
        <p className="text-sm text-muted-foreground">
          Deterministic replay of every multi-agent execution. Click a run to view the timeline.
        </p>
      </div>

      <Card className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <Label htmlFor="filter-project">Project ID</Label>
            <Input
              id="filter-project"
              value={filters.projectId ?? ""}
              onChange={(e) =>
                setFilters((f) => ({ ...f, projectId: e.target.value || undefined }))
              }
              placeholder="proj_…"
            />
          </div>
          <div>
            <Label htmlFor="filter-session">Session ID</Label>
            <Input
              id="filter-session"
              value={filters.sessionId ?? ""}
              onChange={(e) =>
                setFilters((f) => ({ ...f, sessionId: e.target.value || undefined }))
              }
              placeholder="analysis ID"
            />
          </div>
          <div>
            <Label htmlFor="filter-from">From</Label>
            <Input
              id="filter-from"
              type="date"
              value={filters.from ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value || undefined }))}
            />
          </div>
          <div>
            <Label htmlFor="filter-to">To</Label>
            <Input
              id="filter-to"
              type="date"
              value={filters.to ?? ""}
              onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value || undefined }))}
            />
          </div>
        </div>
      </Card>

      <Card className="p-0">
        {runs.isLoading ? (
          <div className="p-6">
            <SkeletonText lines={4} />
          </div>
        ) : runs.isError ? (
          <div className="p-6 text-sm text-red-600">
            Failed to load runs: {(runs.error as Error).message}
          </div>
        ) : (runs.data?.items ?? []).length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="runs-empty">
            No runs yet. Trigger an analysis to populate the timeline.
          </div>
        ) : (
          <div className="p-4">
            <ResponsiveTable
              data={runs.data!.items}
              getRowKey={(r) => r.id}
              ariaLabel="Agent runs"
              data-testid="runs-table"
              columns={runColumns}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
