/**
 * Epic #803 (Epic 09) — Domain Eval panel for the leaderboard "Domain Eval"
 * tab. Lists BA-pipeline regression runs with a corpus-F1 trend, a run table
 * (precision / recall / F1 / ROUGE-L + drift flag), and a drill-in detail
 * view (calibration bins + per-item expected-vs-actual field diffs).
 *
 * File-backed: data comes from `/eval/domain/runs` and `/eval/domain/runs/:id`
 * which stream committed `eval-results/<runId>.json` envelopes.
 */
"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { describeBaselineStaleness } from "@metis/shared";
import { DomainTrendChart } from "@/components/eval/domain-trend-chart";
import { DomainFieldDiff } from "@/components/eval/domain-field-diff";
import {
  domainEvalApi,
  type DomainDrift,
  type DomainEvalRunSummary,
  type DomainItemResult,
} from "@/lib/eval-api";
import { queryKeys } from "@/lib/query-keys";

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

export function DomainEvalPanel() {
  const [days, setDays] = useState(90);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const list = useQuery({
    queryKey: queryKeys.eval.domainRuns(days),
    queryFn: () => domainEvalApi.listRuns({ days }),
  });

  const runs = list.data?.runs ?? [];

  return (
    <div className="space-y-6" data-testid="domain-eval-panel">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">BA Pipeline Domain Eval</h2>
          <p className="text-sm text-muted-foreground">
            Nightly regression of requirement extraction against the golden corpus.
          </p>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger
            data-testid="domain-days-filter"
            aria-label="Domain eval time window"
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

      <Card className="p-4" data-testid="domain-trend-card">
        <h3 className="mb-2 text-sm font-semibold">Corpus F1 over time</h3>
        <DomainTrendChart runs={runs} />
      </Card>

      <Card className="p-0">
        {list.isLoading ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="domain-runs-loading">
            Loading domain runs…
          </div>
        ) : list.isError ? (
          <div className="p-6 text-sm text-red-600" data-testid="domain-runs-error">
            Failed to load domain eval runs.
          </div>
        ) : runs.length === 0 ? (
          <div className="p-6 text-sm text-muted-foreground" data-testid="domain-runs-empty">
            No domain eval runs yet. Trigger one with <code>pnpm eval:domain</code>.
          </div>
        ) : (
          <DomainRunsTable runs={runs} selectedRunId={selectedRunId} onSelect={setSelectedRunId} />
        )}
      </Card>

      {selectedRunId ? (
        <DomainRunDetail runId={selectedRunId} onClose={() => setSelectedRunId(null)} />
      ) : null}
    </div>
  );
}

function DomainRunsTable({
  runs,
  selectedRunId,
  onSelect,
}: {
  runs: DomainEvalRunSummary[];
  selectedRunId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <Table data-testid="domain-runs-table">
      <TableHeader>
        <TableRow>
          <TableHead>Run</TableHead>
          <TableHead>Model</TableHead>
          <TableHead>Items</TableHead>
          <TableHead>Precision</TableHead>
          <TableHead>Recall</TableHead>
          <TableHead>F1</TableHead>
          <TableHead>ROUGE-L</TableHead>
          <TableHead>Drift</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((r) => {
          const isSelected = r.runId === selectedRunId;
          return (
            <TableRow
              key={r.runId}
              className={isSelected ? "bg-muted/50" : ""}
              data-testid={`domain-run-row-${r.runId}`}
              data-selected={isSelected ? "true" : "false"}
            >
              <TableCell className="font-mono text-xs">{r.runId}</TableCell>
              <TableCell>{r.model}</TableCell>
              <TableCell>{r.itemCount}</TableCell>
              <TableCell>{pct(r.corpusPrecision)}</TableCell>
              <TableCell>{pct(r.corpusRecall)}</TableCell>
              <TableCell className="font-medium">{pct(r.corpusF1)}</TableCell>
              <TableCell>{pct(r.meanRougeL)}</TableCell>
              <TableCell>
                <DomainDriftCell runId={r.runId} drift={r.drift} driftAlert={r.driftAlert} />
              </TableCell>
              <TableCell className="text-right">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid={`domain-run-inspect-${r.runId}`}
                  onClick={() => onSelect(r.runId)}
                >
                  {isSelected ? "Viewing" : "Inspect"}
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Issue #1333 — a drift verdict measured against stale history must not read as
 * a clean "OK".
 *
 * `eval-domain-nightly.yml` committed no envelope between 2026-07-21 and the
 * #1333 fix, so every run in that window compared against the same 2026-07-21
 * baseline and came back inside the threshold. Rendering those rows as a bare
 * "OK" invites the reader to treat five weeks of repeated comparisons as five
 * weeks of stability. The caveat is rendered INLINE — never tooltip-only — so it
 * is visible in the table without hovering.
 */
export function DomainDriftCell({
  runId,
  drift,
  driftAlert,
}: {
  runId: string;
  drift: DomainDrift;
  driftAlert: boolean;
}) {
  const staleness = describeBaselineStaleness(drift);
  return (
    <div className="flex flex-col gap-0.5">
      {driftAlert ? (
        <span
          className="w-fit rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700"
          data-testid={`domain-drift-badge-${runId}`}
        >
          Drift
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">OK</span>
      )}
      {staleness ? (
        <span
          className="w-fit rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
          data-testid={`domain-drift-stale-${runId}`}
          title={staleness}
        >
          Stale baseline ({Math.round(drift.baselineAgeDays ?? 0)}d) — not week-over-week
        </span>
      ) : null}
    </div>
  );
}

function DomainRunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const detail = useQuery({
    queryKey: queryKeys.eval.domainRun(runId),
    queryFn: () => domainEvalApi.getRun(runId),
  });

  return (
    <Card className="p-4" data-testid={`domain-run-detail-${runId}`}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Run detail · <span className="font-mono text-xs">{runId}</span>
        </h3>
        <Button variant="ghost" size="sm" data-testid="domain-detail-close" onClick={onClose}>
          Close
        </Button>
      </div>

      {detail.isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="domain-detail-loading">
          Loading run detail…
        </p>
      ) : detail.isError || !detail.data ? (
        <p className="text-sm text-red-600" data-testid="domain-detail-error">
          Failed to load run detail.
        </p>
      ) : (
        <div className="space-y-5">
          <section aria-label="Calibration" data-testid="domain-calibration">
            <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Confidence calibration
            </h4>
            <Table className="text-xs">
              <TableHeader>
                <TableRow>
                  <TableHead>Bucket</TableHead>
                  <TableHead>Count</TableHead>
                  <TableHead>Mean confidence</TableHead>
                  <TableHead>Accuracy</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.data.calibration
                  .filter((b) => b.count > 0)
                  .map((b) => (
                    <TableRow key={b.bucket} data-testid={`domain-calibration-bin-${b.bucket}`}>
                      <TableCell className="px-2 py-1">{b.bucket}</TableCell>
                      <TableCell className="px-2 py-1">{b.count}</TableCell>
                      <TableCell className="px-2 py-1">{pct(b.meanConfidence)}</TableCell>
                      <TableCell className="px-2 py-1">{pct(b.accuracy)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </section>

          <section aria-label="Per-item results" data-testid="domain-items">
            <h4 className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
              Per-item results
            </h4>
            <div className="space-y-2">
              {detail.data.items.map((item) => (
                <DomainItemRow key={item.itemId} item={item} />
              ))}
            </div>
          </section>
        </div>
      )}
    </Card>
  );
}

function DomainItemRow({ item }: { item: DomainItemResult }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded border" data-testid={`domain-item-${item.itemId}`}>
      <button
        type="button"
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm"
        aria-expanded={expanded}
        data-testid={`domain-item-toggle-${item.itemId}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="font-medium">
          {item.title} <span className="text-xs text-muted-foreground">({item.docType})</span>
        </span>
        <span className="text-xs text-muted-foreground">
          F1 {pct(item.f1)} · TP {item.truePositives} · FP {item.falsePositives} · FN{" "}
          {item.falseNegatives}
        </span>
      </button>
      {expanded ? (
        <div className="border-t p-3">
          <DomainFieldDiff item={item} />
        </div>
      ) : null}
    </div>
  );
}
