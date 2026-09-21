/**
 * Epic #708 / Issue #717 — Project-scoped scan history list.
 *
 * Lists all scans for the project across connected repositories.
 * From here users can start a new scan (per-repo) or drill into triage.
 *
 * Issue #422 (Epic #406) — live scan progress. Security scans run through the
 * scheduler task-queue, which already emits `task:progress` / `task:status` to
 * the `task:{taskId}` room. The server now surfaces each in-flight scan's
 * `taskId`; each row subscribes to those EXISTING events (`useTaskProgress`) and
 * renders a live progress bar + phase label. The poll is demoted from 8s to a
 * 30s safety net (socket push is the primary source of truth); a terminal
 * `task:status` updates the row and fires a toast. Authorization is unchanged —
 * a user lacking `task.read` gets an `auth:error` (surfaced by the socket client,
 * not the console) and simply falls back to the poll.
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { TaskStatusEvent } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { scannerApi, type Scan } from "@/lib/scanner-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { useTaskProgress } from "@/hooks/use-task-progress";

/** Poll fallback: socket push is primary, so this is a slow safety net (#422). */
const SCANS_POLL_FALLBACK_MS = 30_000;

export default function ScansListPage() {
  const params = useParams<{ id: string }>();
  const projectId = params.id;
  const queryClient = useQueryClient();

  const scansQuery = useQuery({
    queryKey: ["scanner", "scans", projectId],
    queryFn: () => scannerApi.listProjectScans(projectId),
    // #422 — demoted from 8s to a 30s safety net now that live `task:*` events
    // drive the UI. Avoids a redundant fast double source of truth that flickers.
    refetchInterval: SCANS_POLL_FALLBACK_MS,
  });

  // Connected repos drive the empty-state "Scan for bugs" deep-link: the real
  // scan action lives on the per-repo scanner page, not the global repo list.
  const reposQuery = useQuery({
    queryKey: ["connectors", "repos", projectId],
    queryFn: () => repoConnectorsApi.list(projectId),
    enabled: Boolean(projectId),
  });

  // One connected repo → deep-link straight to its scanner. Zero/many (or
  // still loading) → the project-scoped connections list, where the user picks
  // a repo and navigates to its scanner.
  const repos = reposQuery.data ?? [];
  const scanCtaHref =
    repos.length === 1
      ? `/projects/${projectId}/repositories/${repos[0].id}/scanner`
      : `/projects/${projectId}/connections`;
  const scanCtaCopy =
    repos.length === 1 ? "Open the repository scanner" : "Go to a connected repository";

  // On a terminal task:status, pull the final scan row (status/findings) without
  // waiting for the slow poll, and toast the outcome (#422 AC4).
  const onScanTerminal = useCallback(
    (scan: Scan, status: TaskStatusEvent) => {
      void queryClient.invalidateQueries({ queryKey: ["scanner", "scans", projectId] });
      const label = scan.repoConnectionId;
      if (status.status === "completed") {
        toast.success(`Scan finished for ${label}`);
      } else if (status.status === "failed") {
        toast.error(`Scan failed for ${label}`);
      } else if (status.status === "cancelled") {
        toast(`Scan cancelled for ${label}`);
      }
    },
    [queryClient, projectId],
  );

  return (
    <div className="space-y-6 p-6" data-testid="scans-list-root">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Bug Scans</h1>
          <p className="text-sm text-muted-foreground mt-1">
            AI-powered scan results for this project's connected repositories.
          </p>
        </div>
        <Link
          href={`/projects/${projectId}/rule-sets`}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Manage Rules
        </Link>
      </header>

      <Card className="p-4" data-testid="scans-list-card">
        {scansQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading scans…</p>
        ) : scansQuery.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {(scansQuery.error as Error).message}
          </p>
        ) : !scansQuery.data?.length ? (
          <div className="space-y-2 text-center py-8">
            <p className="text-sm text-muted-foreground">No scans yet.</p>
            <p className="text-xs text-muted-foreground">
              <Link href={scanCtaHref} className="underline">
                {scanCtaCopy}
              </Link>{" "}
              and click <strong>Scan for bugs</strong> to start your first scan.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm" data-testid="scans-table">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="pb-2 font-medium">Repository</th>
                <th className="pb-2 font-medium">Mode</th>
                <th className="pb-2 font-medium">Status</th>
                <th className="pb-2 font-medium">Commit</th>
                <th className="pb-2 font-medium">Findings</th>
                <th className="pb-2 font-medium">Started</th>
                <th className="pb-2 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {scansQuery.data.map((scan) => (
                <ScanRow
                  key={scan.id}
                  scan={scan}
                  projectId={projectId}
                  onTerminal={onScanTerminal}
                />
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <p className="text-xs text-muted-foreground">
        Scans require the repository to be indexed. To start a scan, navigate to{" "}
        <Link href={`/projects/${projectId}/connections`} className="underline">
          Connections
        </Link>
        , select a repository, and click <strong>Scan for bugs</strong>.
      </p>
    </div>
  );
}

/**
 * One scan row. Subscribes to its in-flight task's `task:*` events (#422) so a
 * running scan shows a live phase label + progress bar. Only in-flight scans
 * carry a `taskId`; terminal scans pass `null` and the hook is a no-op.
 */
function ScanRow({
  scan,
  projectId,
  onTerminal,
}: {
  scan: Scan & { findingCount?: number };
  projectId: string;
  onTerminal: (scan: Scan, status: TaskStatusEvent) => void;
}) {
  const handleTerminal = useCallback(
    (status: TaskStatusEvent) => onTerminal(scan, status),
    [onTerminal, scan],
  );
  // Subscribe only while the scan is in flight; terminal scans have no live task.
  const liveTaskId = scan.status === "pending" || scan.status === "running" ? scan.taskId : null;
  const { progress } = useTaskProgress(liveTaskId, handleTerminal);

  const isLive = scan.status === "running" || scan.status === "pending";

  return (
    <tr className="py-2" data-testid={`scan-row-${scan.id}`}>
      <td className="py-2 font-mono text-xs">{scan.repoConnectionId}</td>
      <td className="py-2 capitalize">{scan.mode}</td>
      <td className="py-2">
        <div className="space-y-1">
          <StatusBadge status={scan.status} />
          {isLive && progress ? (
            <ScanProgress
              step={progress.step}
              current={progress.current}
              total={progress.total}
              pct={progress.progress}
            />
          ) : null}
        </div>
      </td>
      <td className="py-2 font-mono text-xs">{scan.commitSha.slice(0, 8)}</td>
      <td className="py-2 text-center">{scan.findingCount ?? "—"}</td>
      <td className="py-2 text-xs text-muted-foreground">
        {new Date(scan.createdAt).toLocaleString()}
      </td>
      <td className="py-2 text-right">
        {scan.status === "completed" || scan.status === "running" ? (
          <Link
            href={`/projects/${projectId}/scans/${scan.id}`}
            className="text-xs text-primary underline"
          >
            {scan.status === "running" ? "View progress" : "Triage"}
          </Link>
        ) : null}
      </td>
    </tr>
  );
}

/** Live progress bar + phase label rendered from `task:progress` events (#422). */
function ScanProgress({
  step,
  current,
  total,
  pct,
}: {
  step: string;
  current?: number;
  total?: number;
  pct?: number;
}) {
  // Prefer the explicit 0-100 pct; else derive from current/total; else show an
  // indeterminate phase label with no bar.
  const computed =
    typeof pct === "number"
      ? pct
      : typeof current === "number" && typeof total === "number" && total > 0
        ? Math.min(100, Math.max(0, Math.round((current / total) * 100)))
        : undefined;
  const phase = humanizePhase(step);
  return (
    <div className="space-y-0.5" data-testid="scan-progress">
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span data-testid="scan-progress-phase">{phase}</span>
        <span data-testid="scan-progress-count">
          {typeof current === "number" && typeof total === "number"
            ? `${current}/${total}`
            : typeof computed === "number"
              ? `${computed}%`
              : ""}
        </span>
      </div>
      {typeof computed === "number" ? (
        <div
          className="h-1 w-full overflow-hidden rounded bg-muted"
          role="progressbar"
          aria-valuenow={computed}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Scan progress"
        >
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${computed}%` }}
            data-testid="scan-progress-bar"
          />
        </div>
      ) : null}
    </div>
  );
}

/** Turn a machine step like "scanner.scan.symbol" into a readable phase label. */
function humanizePhase(step: string): string {
  const map: Record<string, string> = {
    "scanner.run-scan:start": "Starting scan",
    "scanner.scan.symbol": "Scanning symbols",
    "scanner.run-scan:complete": "Finishing up",
  };
  if (map[step]) return map[step];
  // Fallback: take the last dotted segment, replace separators with spaces.
  const tail = step.split(":").pop() ?? step;
  const last = tail.split(".").pop() ?? tail;
  return last.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function StatusBadge({ status }: { status: string }) {
  const colours: Record<string, string> = {
    pending: "bg-muted text-muted-foreground",
    running: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    completed: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    failed: "bg-destructive/15 text-destructive",
    cancelled: "bg-muted text-muted-foreground",
  };
  return (
    <span
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium ${colours[status] ?? colours.pending}`}
    >
      {status}
    </span>
  );
}
