/**
 * Epic #708 / Issue #717 — Per-repository scanner detail page.
 *
 * Lists prior scans for a repo connection and lets a user kick off a new scan.
 */
"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { scannerApi, type ScanMode } from "@/lib/scanner-api";

export default function RepoScannerPage() {
  const params = useParams<{ id: string; repoId: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const projectId = params.id;
  const repoId = params.repoId;
  const [mode, setMode] = useState<ScanMode>("both");
  const [error, setError] = useState<string | null>(null);
  const [showCostWarning, setShowCostWarning] = useState(false);

  const scansQuery = useQuery({
    queryKey: ["scanner", "scans", projectId, repoId],
    queryFn: () => scannerApi.listScans(projectId, repoId),
    refetchInterval: 5000,
  });

  // Epic #708 — the "Scan for bugs" CTA must be gated on the repository
  // having a code graph indexed. Without an index, the scanner has no
  // symbols to walk and the server now rejects with 409 INDEX_REQUIRED.
  const indexStatusQuery = useQuery({
    queryKey: ["scanner", "index-status", projectId, repoId],
    queryFn: () => scannerApi.getIndexStatus(projectId, repoId),
    refetchInterval: 10_000,
  });
  const isIndexed = Boolean(indexStatusQuery.data?.indexed);
  const indexStatusReady = !indexStatusQuery.isLoading;

  // Cost estimate: ~9,000 tokens per symbol (worst-case with 2 Sonnet FP-filter
  // votes). At standard Bedrock rates (~$3.50/MTok blended) that's ~$0.032/symbol.
  const symbolCount = indexStatusQuery.data?.symbolCount ?? 0;
  const estMaxCostUsd = Math.round(symbolCount * 0.032 * 100) / 100;
  const estMaxTokensM = Math.round(((symbolCount * 9000) / 1_000_000) * 10) / 10;

  const startMutation = useMutation({
    mutationFn: () => scannerApi.startScan(projectId, repoId, { mode }),
    onSuccess: (scan) => {
      setError(null);
      qc.invalidateQueries({ queryKey: ["scanner", "scans", projectId, repoId] });
      router.push(`/projects/${projectId}/scans/${scan.id}`);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="scanner-repo-root">
      <header className="space-y-2">
        <Link
          href={`/projects/${projectId}/connections`}
          className="text-xs text-muted-foreground underline"
        >
          ← Back to connections
        </Link>
        <h1 className="text-2xl font-semibold">AI bug scanner</h1>
        <p className="text-sm text-muted-foreground">
          Run rule-based and heuristic scans against this repository. Each scan runs in the
          background; results are reviewed and triaged below before being published.
        </p>
      </header>

      <Card className="space-y-3 p-4" data-testid="scanner-repo-start-card">
        <h2 className="text-base font-semibold">Start a new scan</h2>
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-sm">
            <span className="mb-1 text-muted-foreground">Mode</span>
            <select
              className="rounded border bg-background px-2 py-1 text-sm"
              data-testid="scanner-repo-mode"
              value={mode}
              onChange={(e) => setMode(e.target.value as ScanMode)}
            >
              <option value="both">Rules + heuristic</option>
              <option value="rules">Rules only</option>
              <option value="heuristic">Heuristic only</option>
              <option value="spec">Spec compliance</option>
            </select>
          </label>
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
            data-testid="scanner-repo-start"
            disabled={startMutation.isPending || !indexStatusReady || !isIndexed}
            title={
              indexStatusReady && !isIndexed
                ? "Index this repository first — open the repository's code graph and run an ingest before scanning."
                : undefined
            }
            onClick={() => setShowCostWarning(true)}
          >
            {startMutation.isPending ? "Queuing…" : "Scan for bugs"}
          </button>
          <Link
            href={`/projects/${projectId}/rule-sets`}
            className="text-xs underline"
            data-testid="scanner-repo-rules-link"
          >
            Manage rule sets →
          </Link>
        </div>
        {indexStatusReady && !isIndexed ? (
          <p
            className="text-xs text-muted-foreground"
            data-testid="scanner-repo-index-required"
            role="status"
          >
            Repository is not indexed yet. Run the code-graph ingest for this repository before
            scanning — the scanner needs the symbol/edge tables to walk the codebase.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive" data-testid="scanner-repo-error">
            {error}
          </p>
        ) : null}
      </Card>

      <Card className="p-4" data-testid="scanner-repo-scans-card">
        <h2 className="mb-2 text-base font-semibold">Past scans</h2>
        {scansQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : scansQuery.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {(scansQuery.error as Error).message}
          </p>
        ) : !scansQuery.data?.length ? (
          <p className="text-xs text-muted-foreground" data-testid="scanner-repo-scans-empty">
            No scans yet.
          </p>
        ) : (
          <table className="w-full text-left text-xs" data-testid="scanner-repo-scans-table">
            <thead>
              <tr className="text-muted-foreground">
                <th className="py-1 pr-3 font-medium">Started</th>
                <th className="py-1 pr-3 font-medium">Mode</th>
                <th className="py-1 pr-3 font-medium">Status</th>
                <th className="py-1 pr-3 font-medium">Symbols</th>
                <th className="py-1 pr-3 font-medium">Tokens</th>
                <th className="py-1 pr-3 font-medium">Open</th>
              </tr>
            </thead>
            <tbody>
              {scansQuery.data.map((s) => (
                <tr key={s.id} className="border-t" data-testid={`scanner-repo-scan-row-${s.id}`}>
                  <td className="py-1 pr-3">{new Date(s.createdAt).toLocaleString()}</td>
                  <td className="py-1 pr-3">{s.mode}</td>
                  <td className="py-1 pr-3">{s.status}</td>
                  <td className="py-1 pr-3">
                    {s.scannedSymbols} / {s.totalSymbols}
                  </td>
                  <td className="py-1 pr-3">{s.totalTokens.toLocaleString()}</td>
                  <td className="py-1 pr-3">
                    <Link
                      href={`/projects/${projectId}/scans/${s.id}`}
                      className="underline"
                      data-testid={`scanner-repo-scan-open-${s.id}`}
                    >
                      Triage →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Dialog open={showCostWarning} onOpenChange={setShowCostWarning}>
        <DialogContent data-testid="scanner-cost-warning-dialog">
          <DialogHeader>
            <DialogTitle>Start bug scan?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p>
              This scan will analyze <strong>{symbolCount.toLocaleString()} symbols</strong> in the
              codebase using AI models.
            </p>
            <div className="rounded border bg-muted/50 p-3 space-y-1">
              <p className="font-medium text-muted-foreground uppercase text-xs tracking-wide">
                Worst-case cost estimate
              </p>
              <p>
                <span className="text-lg font-semibold">${estMaxCostUsd.toFixed(2)}</span>
                <span className="text-muted-foreground ml-2 text-xs">
                  (~{estMaxTokensM}M tokens at standard Bedrock rates)
                </span>
              </p>
              <p className="text-xs text-muted-foreground">
                Actual cost will be lower — Sonnet is only called when Haiku finds a candidate bug.
                Clean code with few issues costs significantly less.
              </p>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setShowCostWarning(false)}
              data-testid="scanner-cost-warning-cancel"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setShowCostWarning(false);
                startMutation.mutate();
              }}
              data-testid="scanner-cost-warning-confirm"
            >
              Start scan
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
