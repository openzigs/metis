/**
 * Epic #194 (C.5) — Leaderboard table component.
 *
 * Renders the latest BenchRun rows with score, model, status, and a link
 * to the per-run detail. Pure presentational — data is supplied by the
 * parent page via TanStack Query.
 */
"use client";

import Link from "next/link";
import type { BenchRunSummary } from "@/lib/eval-api";

export interface LeaderboardTableProps {
  runs: BenchRunSummary[];
}

const BENCH_LABELS: Record<string, string> = {
  "swe-bench-pro": "SWE-bench-Pro",
  "tau-bench": "TAU-bench",
};

function fmtPct(score: number): string {
  return `${(score * 100).toFixed(1)}%`;
}

function fmtCost(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 16).replace("T", " ");
}

export function LeaderboardTable({ runs }: LeaderboardTableProps) {
  if (runs.length === 0) {
    return (
      <p
        className="rounded border border-dashed p-6 text-center text-sm text-muted-foreground"
        data-testid="leaderboard-empty"
      >
        No benchmark runs yet. Trigger one with the &quot;Run now&quot; button (admins only) or wait
        for the nightly job.
      </p>
    );
  }
  return (
    <table className="w-full border-collapse text-sm" data-testid="leaderboard-table">
      <thead className="bg-muted text-left">
        <tr>
          <th className="px-3 py-2">Benchmark</th>
          <th className="px-3 py-2">Model</th>
          <th className="px-3 py-2 text-right">Score</th>
          <th className="px-3 py-2 text-right">Tasks</th>
          <th className="px-3 py-2 text-right">Mean cost</th>
          <th className="px-3 py-2 text-right">Mean latency</th>
          <th className="px-3 py-2">Status</th>
          <th className="px-3 py-2">Started</th>
          <th className="px-3 py-2"></th>
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} className="border-t" data-testid={`leaderboard-row-${run.id}`}>
            <td className="px-3 py-2">{BENCH_LABELS[run.benchmark] ?? run.benchmark}</td>
            <td className="px-3 py-2">{run.model}</td>
            <td className="px-3 py-2 text-right" data-testid={`row-score-${run.id}`}>
              {fmtPct(run.score)}
            </td>
            <td className="px-3 py-2 text-right">
              {run.passedTasks}/{run.totalTasks}
            </td>
            <td className="px-3 py-2 text-right">{fmtCost(run.meanCostCents)}</td>
            <td className="px-3 py-2 text-right">{run.meanLatencyMs}ms</td>
            <td className="px-3 py-2">
              <StatusPill status={run.status} />
            </td>
            <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDate(run.startedAt)}</td>
            <td className="px-3 py-2">
              <Link
                href={`/eval/leaderboard/${run.id}`}
                className="text-xs underline"
                data-testid={`row-detail-link-${run.id}`}
              >
                detail
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StatusPill({ status }: { status: string }) {
  const palette: Record<string, string> = {
    completed: "bg-green-100 text-green-900",
    running: "bg-yellow-100 text-yellow-900",
    failed: "bg-red-100 text-red-900",
    disabled: "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs ${palette[status] ?? "bg-muted"}`}>
      {status}
    </span>
  );
}
