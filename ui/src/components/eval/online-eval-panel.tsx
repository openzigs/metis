/**
 * Epic #1316 / issue #1321 — Online Eval panel (operator view of live scores).
 *
 * Shows the state of the sampler (on/off, sample rate, token budget, buffered
 * samples) and the trend of mean faithfulness across completed windows.
 *
 * The honesty marking is the point of the panel as much as the chart: while the
 * configured judge is `StubRagasJudge` the numbers are a lexical heuristic and
 * NOT a quality signal (#1317). Presenting them without that caveat is how a
 * placeholder metric becomes a dashboard someone trusts.
 *
 * The marking is driven by each window's OWN `judgeMeaningful`, not only by
 * `/status`. `/status` describes the judge configured *right now*; it says
 * nothing about the judge that produced a window rendered from history. Gating
 * the caveat on `/status` alone fails twice: while `/status` is loading or 403s
 * the rows render uncaveated, and once #1317 lands every historical stub window
 * silently joins the "real" trend line.
 *
 * File-backed: data comes from `/eval/online/windows` and `/eval/online/status`,
 * which stream the content-free `eval-results/online/*.json` envelopes.
 */
"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OnlineTrendChart } from "@/components/eval/online-trend-chart";
import { onlineEvalApi, type OnlineEvalWindowSummary } from "@/lib/eval-api";
import { queryKeys } from "@/lib/query-keys";

/**
 * `null` is UNVERIFIABLE, not zero (#1329). Rendered as an explicit marker so a
 * window the judge could not score never reads as a confident 0.0%.
 */
function pct(x: number | null): string {
  if (x == null) return "n/a";
  return `${(x * 100).toFixed(1)}%`;
}

export function OnlineEvalPanel() {
  const [days, setDays] = useState(90);

  const status = useQuery({
    queryKey: queryKeys.eval.onlineStatus(),
    queryFn: () => onlineEvalApi.getStatus(),
  });

  const list = useQuery({
    queryKey: queryKeys.eval.onlineWindows(days),
    queryFn: () => onlineEvalApi.listWindows({ days }),
  });

  const windows = list.data?.windows ?? [];
  const s = status.data;
  // Per-window truth first; `/status` is only the current sampler config.
  const stubWindows = windows.filter((w) => !w.judgeMeaningful);
  // #1329 — windows the judge could not score at all. They carry `null`, not 0,
  // and the trend chart leaves them out rather than plotting them on the floor.
  const unverifiableWindows = windows.filter((w) => w.meanScores.faithfulness == null);
  const showStubWarning = (s != null && !s.judgeMeaningful) || stubWindows.length > 0;
  const stubJudgeNames = Array.from(
    new Set([...(s && !s.judgeMeaningful ? [s.judge] : []), ...stubWindows.map((w) => w.judge)]),
  );

  return (
    <div className="space-y-6" data-testid="online-eval-panel">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Online Eval (sampled live runs)</h2>
          <p className="text-sm text-muted-foreground">
            A read-only observer scores a bounded sample of completed production runs. It never
            changes what a user sees.
          </p>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger
            data-testid="online-days-filter"
            aria-label="Online eval time window"
            className="w-auto gap-1"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="30">30 days</SelectItem>
            <SelectItem value="90">90 days</SelectItem>
            <SelectItem value="180">180 days</SelectItem>
            <SelectItem value="365">365 days</SelectItem>
          </SelectContent>
        </Select>
      </header>

      {showStubWarning ? (
        <Card
          className="border-yellow-300 bg-yellow-50 p-3 text-sm dark:bg-yellow-950/30"
          data-testid="online-stub-judge-warning"
        >
          <strong>
            {stubWindows.length > 0 && s?.judgeMeaningful
              ? "Some of these scores are not a quality signal."
              : "These scores are not a quality signal."}
          </strong>{" "}
          {stubJudgeNames.length > 0 ? (
            <>
              <code>{stubJudgeNames.join(", ")}</code>{" "}
              {stubJudgeNames.length > 1 ? "are lexical placeholders" : "is a lexical placeholder"}{" "}
              whose <code>faithfulness</code> does not measure faithfulness.{" "}
            </>
          ) : null}
          Rows and points marked <em>stub</em> below were produced by such a judge; they are never
          compared against real-judge windows and can never raise a drift alert (issue #1317).
        </Card>
      ) : null}

      {s ? (
        <Card className="p-4" data-testid="online-status-card">
          <h3 className="mb-2 text-sm font-semibold">Sampler status</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Sampling</dt>
              <dd data-testid="online-enabled">
                {s.enabled ? `On — ${pct(s.sampleRate)} of runs` : "Off"}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Drift alerts</dt>
              <dd data-testid="online-alerts-enabled">{s.driftAlertsEnabled ? "On" : "Off"}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Token budget ({s.budget.monthBucket})</dt>
              <dd data-testid="online-budget">
                {s.budget.tokensUsed.toLocaleString()} / {s.budget.tokensCap.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Buffered</dt>
              <dd data-testid="online-pending">
                {s.pendingSamples} / {s.windowSize} samples
              </dd>
            </div>
          </dl>
        </Card>
      ) : null}

      <Card className="p-4" data-testid="online-trend-card">
        <h3 className="mb-2 text-sm font-semibold">Mean faithfulness over time</h3>
        <OnlineTrendChart windows={windows} />
        {stubWindows.length > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground" data-testid="online-trend-stub-note">
            {stubWindows.length} of {windows.length} points are stub-judge windows (hollow amber
            squares, dashed segments) and are not a quality signal.
          </p>
        ) : null}
        {unverifiableWindows.length > 0 ? (
          <p
            className="mt-2 text-xs text-muted-foreground"
            data-testid="online-trend-unverifiable-note"
          >
            {unverifiableWindows.length} of {windows.length} windows had no measurable faithfulness
            (the judge could not score them) and are not plotted — an unverifiable window is not a
            zero.
          </p>
        ) : null}
      </Card>

      <Card className="p-0">
        {list.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="online-windows-loading">
            Loading online eval windows…
          </div>
        ) : list.isError ? (
          <div className="p-6 text-sm text-red-600" data-testid="online-windows-error">
            Failed to load online eval windows.
          </div>
        ) : windows.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="online-windows-empty">
            No completed windows yet. Enable sampling with <code>ONLINE_EVAL_ENABLED=true</code>.
          </div>
        ) : (
          <OnlineWindowsTable windows={windows} />
        )}
      </Card>
    </div>
  );
}

function OnlineWindowsTable({ windows }: { windows: OnlineEvalWindowSummary[] }) {
  return (
    <Table data-testid="online-windows-table">
      <TableHeader>
        <TableRow>
          <TableHead>Window</TableHead>
          <TableHead className="text-right">Samples</TableHead>
          <TableHead className="text-right">Faithfulness</TableHead>
          <TableHead className="text-right">Answer relevancy</TableHead>
          <TableHead>Judge</TableHead>
          <TableHead>Drift</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {windows.map((w) => (
          <TableRow
            key={w.windowId}
            data-testid={`online-window-${w.windowId}`}
            data-judge-meaningful={w.judgeMeaningful ? "true" : "false"}
            className={w.judgeMeaningful ? undefined : "text-muted-foreground"}
          >
            <TableCell className="font-mono text-xs">{w.windowId}</TableCell>
            <TableCell className="text-right">{w.sampleCount}</TableCell>
            <TableCell
              className="text-right"
              data-testid={`online-window-faithfulness-${w.windowId}`}
              title={
                w.meanScores.faithfulness == null
                  ? `Unverifiable — 0 of ${w.sampleCount} samples produced a faithfulness score`
                  : `${w.scored.faithfulness} of ${w.sampleCount} samples scored`
              }
            >
              {pct(w.meanScores.faithfulness)}
            </TableCell>
            <TableCell className="text-right">{pct(w.meanScores.answer_relevancy)}</TableCell>
            <TableCell className="text-xs">
              {w.judge}
              {w.judgeMeaningful ? null : (
                <span
                  className="ml-1 rounded bg-yellow-100 px-1 py-0.5 text-[10px] font-semibold uppercase text-yellow-900 dark:bg-yellow-900/40 dark:text-yellow-200"
                  title="Lexical placeholder judge — not a quality signal (#1317)"
                  data-testid={`online-window-stub-${w.windowId}`}
                >
                  stub
                </span>
              )}
            </TableCell>
            <TableCell>
              {w.driftAlert ? (
                <span className="text-red-600" data-testid={`online-drift-${w.windowId}`}>
                  Drift
                </span>
              ) : (
                <span className="text-muted-foreground">{w.drift.reason}</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
