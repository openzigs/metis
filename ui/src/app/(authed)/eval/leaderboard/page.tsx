/**
 * Epic #194 (C.5) — Eval leaderboard page.
 *
 * Lists the latest BenchRun rows with a sortable table + score-over-time
 * sparkline per benchmark. Admins see a "Run now" button that triggers a
 * manual benchmark execution. Non-admins get read-only access.
 *
 * The page surfaces a "Disabled" notice when `EVAL_NIGHTLY_ENABLED` is
 * unset on the server — the trigger endpoint returns `status: "disabled"`
 * and we render the admin instructions for enabling nightly runs.
 */
"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { LeaderboardTable } from "@/components/eval/leaderboard-table";
import { ScoreTimeSeries } from "@/components/eval/score-time-series";
import { DomainEvalPanel } from "@/components/eval/domain-eval-panel";
import { OnlineEvalPanel } from "@/components/eval/online-eval-panel";
import { evalApi, type Bench, type BenchRunSummary } from "@/lib/eval-api";
import { useAuth } from "@/lib/auth-context";
import { queryKeys } from "@/lib/query-keys";
import { ApiError } from "@/lib/api-client";

const BENCHES: Bench[] = ["swe-bench-pro", "tau-bench"];
const BENCH_LABELS: Record<Bench, string> = {
  "swe-bench-pro": "SWE-bench-Pro",
  "tau-bench": "TAU-bench",
};

export default function EvalLeaderboardPage() {
  const auth = useAuth();
  const isAdmin = auth.user?.role === "admin";
  const qc = useQueryClient();
  const [selectedBench, setSelectedBench] = useState<Bench | "all">("all");
  const [days, setDays] = useState(30);
  const [feedback, setFeedback] = useState<string | null>(null);

  const list = useQuery({
    queryKey: queryKeys.eval.leaderboard(selectedBench, days),
    queryFn: () =>
      evalApi.listLeaderboard({
        bench: selectedBench === "all" ? undefined : selectedBench,
        days,
      }),
  });

  const trigger = useMutation({
    mutationFn: (bench: Bench) => evalApi.triggerRun({ bench, model: "offline-stub" }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: queryKeys.eval.all });
      if (result.status === "disabled") {
        setFeedback(
          result.reason ??
            "Eval is disabled — set EVAL_NIGHTLY_ENABLED=true on the server to enable nightly runs.",
        );
      } else {
        setFeedback(`Triggered ${result.benchRunId ?? "run"} (status: ${result.status}).`);
      }
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.message : "Failed to trigger benchmark";
      setFeedback(msg);
    },
  });

  const runs = list.data?.runs ?? [];
  const runsBySplit = useMemo(() => splitByBench(runs), [runs]);

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="eval-leaderboard-root">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Eval &amp; Bench Leaderboard</h1>
        <p className="text-sm text-muted-foreground">
          Nightly SWE-bench-Pro and TAU-bench results plus the BA-pipeline domain regression suite.{" "}
          <Link className="underline" href="/admin">
            Admin
          </Link>{" "}
          settings → enable nightly runs by setting <code>EVAL_NIGHTLY_ENABLED=true</code>.
        </p>
      </header>

      <Tabs defaultValue="benchmarks">
        <TabsList data-testid="eval-tabs">
          <TabsTrigger value="benchmarks" data-testid="eval-tab-benchmarks">
            Benchmarks
          </TabsTrigger>
          <TabsTrigger value="domain" data-testid="eval-tab-domain">
            Domain Eval
          </TabsTrigger>
          <TabsTrigger value="online" data-testid="eval-tab-online">
            Online Eval
          </TabsTrigger>
        </TabsList>

        <TabsContent value="benchmarks" className="space-y-6">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <select
              data-testid="bench-filter"
              value={selectedBench}
              onChange={(e) => setSelectedBench(e.target.value as Bench | "all")}
              className="rounded border px-2 py-1 text-sm"
            >
              <option value="all">All benchmarks</option>
              {BENCHES.map((b) => (
                <option key={b} value={b}>
                  {BENCH_LABELS[b]}
                </option>
              ))}
            </select>
            <select
              data-testid="days-filter"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="rounded border px-2 py-1 text-sm"
            >
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
            {isAdmin ? (
              <div className="flex items-center gap-1">
                {BENCHES.map((b) => (
                  <Button
                    key={b}
                    data-testid={`trigger-${b}`}
                    variant="outline"
                    size="sm"
                    disabled={trigger.isPending}
                    onClick={() => {
                      setFeedback(null);
                      trigger.mutate(b);
                    }}
                  >
                    Run {BENCH_LABELS[b]}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>

          {feedback ? (
            <Card
              className="border-yellow-200 bg-yellow-50 p-3 text-sm"
              data-testid="trigger-feedback"
            >
              {feedback}
            </Card>
          ) : null}

          <section className="grid grid-cols-1 gap-4 md:grid-cols-2" aria-label="Score trends">
            {BENCHES.map((b) => (
              <Card key={b} className="p-4" data-testid={`trend-${b}`}>
                <h2 className="mb-2 text-sm font-semibold">{BENCH_LABELS[b]} pass-rate</h2>
                <ScoreTimeSeries runs={runsBySplit[b] ?? []} />
              </Card>
            ))}
          </section>

          <Card className="p-0">
            {list.isLoading ? (
              <div className="p-6 text-sm text-muted-foreground" data-testid="leaderboard-loading">
                Loading leaderboard…
              </div>
            ) : list.isError ? (
              <div className="p-6 text-sm text-red-600" data-testid="leaderboard-error">
                Failed to load leaderboard.
              </div>
            ) : (
              <LeaderboardTable runs={runs} />
            )}
          </Card>
        </TabsContent>

        <TabsContent value="domain">
          <DomainEvalPanel />
        </TabsContent>

        <TabsContent value="online">
          <OnlineEvalPanel />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function splitByBench(runs: BenchRunSummary[]): Record<Bench, BenchRunSummary[]> {
  const out: Record<Bench, BenchRunSummary[]> = {
    "swe-bench-pro": [],
    "tau-bench": [],
  };
  for (const r of runs) {
    if (r.benchmark === "swe-bench-pro" || r.benchmark === "tau-bench") {
      out[r.benchmark].push(r);
    }
  }
  return out;
}
