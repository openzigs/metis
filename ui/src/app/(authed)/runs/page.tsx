"use client";

/**
 * Epic #158 — /runs index page.
 *
 * Lists agent runs (replay timeline parents) with project + session filters
 * and a from/to date range. Click a row to drill into the timeline view.
 *
 * Issue #1007 — a chat turn is not a run (it has no replay timeline), so it
 * never appeared here and its cost could not be read. The page now lists chat
 * turns in their own table, read from the usage ledger under the same filters.
 * Every token figure on the page is the ledger's, named with and without cache.
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
import {
  runsApi,
  type AgentRunListFilters,
  type AgentRunSummary,
  type ChatTurnSummary,
} from "@/lib/runs-api";
import { formatRunCost } from "@/lib/run-cost";
import { formatLedgerTokens, runTokensLabel } from "@/lib/run-tokens";
import { PageHeader } from "@/components/ui/page-header";

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
      return "text-success";
    case "failed":
      return "text-destructive";
    case "cancelled":
      return "text-warning";
    default:
      return "text-info";
  }
}

const runColumns: ResponsiveColumn<AgentRunSummary>[] = [
  {
    key: "started",
    header: "Started",
    cell: (r) => (
      <Link
        href={`/runs/${r.id}`}
        className={`${touchTargetClass} text-info underline-offset-2 hover:underline`}
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
  {
    key: "tokens",
    header: "Tokens (usage ledger)",
    // #1007 — the ledger's figures, which move while the run goes; the total
    // stored at finish read 0 until then and missed spend after the run.
    cell: (r) => runTokensLabel({ tokens: r.tokens, storedTotal: r.totalTokens, status: r.status }),
  },
  {
    key: "cost",
    header: "Cost",
    // Show a dollar amount only when cost has actually been attributed
    // (costCents > 0). A run that consumed tokens but has costCents === 0 is
    // unattributed (run-finish never aggregates TokenUsage cost into
    // AgentRun.costCents), so show "—" rather than a misleading "$0.0000".
    cell: (r) => formatRunCost(r),
  },
];

const CHAT_STEP_NOTE: Record<string, string> = {
  "chat-estimated": "estimated",
  "chat-failed": "failed turn",
};

const chatTurnColumns: ResponsiveColumn<ChatTurnSummary>[] = [
  { key: "time", header: "Time", cell: (t) => formatTimestamp(t.createdAt) },
  {
    key: "session",
    header: "Session",
    cell: (t) => <span className="font-mono text-xs">{t.sessionId ?? "—"}</span>,
  },
  {
    key: "model",
    header: "Model",
    cell: (t) => (CHAT_STEP_NOTE[t.step] ? `${t.model} (${CHAT_STEP_NOTE[t.step]})` : t.model),
  },
  { key: "requests", header: "Model calls", cell: (t) => t.requests },
  { key: "tokens", header: "Tokens (usage ledger)", cell: (t) => formatLedgerTokens(t.tokens) },
  {
    key: "cost",
    header: "Cost",
    // A chat turn costs a fraction of a cent: four places, never "$0.00".
    cell: (t) =>
      t.costUsd === null ? "unpriced" : formatRunCost({ costCents: null, costUsd: t.costUsd }),
  },
];

export default function RunsPage() {
  const [filters, setFilters] = useState<AgentRunListFilters>({});

  const queryFilters = useMemo<AgentRunListFilters>(() => ({ ...filters }), [filters]);

  const runs = useQuery({
    queryKey: ["runs", queryFilters],
    queryFn: () => runsApi.list(queryFilters),
  });

  // #1007 — chat turns, from the usage ledger, under the same filters.
  const chatTurns = useQuery({
    queryKey: ["runs-chat-turns", queryFilters],
    queryFn: () => runsApi.chatTurns(queryFilters),
  });

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="runs-page">
      <PageHeader
        title="Agent Runs"
        description="Deterministic replay of every multi-agent execution. Click a run to view the timeline."
      />

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
          <div className="p-6 text-sm text-destructive">
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

      <Card className="space-y-2 p-4" data-testid="runs-chat-turns">
        <div>
          <h2 className="text-base font-semibold">Chat turns</h2>
          <p className="text-xs text-muted-foreground">
            A chat turn is not a run: it has no timeline to replay. Its tokens and cost are read
            here from the usage ledger, one row per turn, newest first. Chat in a session with no
            project is not in a project&apos;s ledger and is not listed.
          </p>
        </div>
        {chatTurns.isLoading ? (
          <SkeletonText lines={3} />
        ) : chatTurns.isError ? (
          <div className="text-sm text-destructive">
            Failed to load chat turns: {(chatTurns.error as Error).message}
          </div>
        ) : (chatTurns.data?.items ?? []).length === 0 ? (
          <div className="text-sm text-muted-foreground" data-testid="runs-chat-turns-empty">
            No chat turns match these filters.
          </div>
        ) : (
          <ResponsiveTable
            data={chatTurns.data!.items}
            getRowKey={(t) => t.id}
            ariaLabel="Chat turns"
            data-testid="runs-chat-turns-table"
            columns={chatTurnColumns}
          />
        )}
      </Card>
    </div>
  );
}
