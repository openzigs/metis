"use client";

/**
 * Live import / connector-sync progress — Issue #424 (Epic #406).
 *
 * Project import and connector sync run async. Before #424 the import page was
 * SILENT while a run was in flight: it fired a toast only on enqueue, then leaned
 * on a 10s `refetchInterval` poll to eventually flip the row's status. This hook
 * makes the active run LIVE.
 *
 * CHANNEL DECISION — `job:lifecycle` under the `import-sync` {@link JobKind}, not
 * `connector:progress`:
 *   - The import run owns a single job id (the {@link ImportRun} id), so it maps
 *     cleanly onto the per-job lifecycle bus (`started`/`progress`/`completed`/
 *     `failed`) the server already widened to `import-sync` in #419.
 *   - `connector:progress` is identity-scoped to a `connectorId` with repo/db
 *     phases (`test|metadata|introspect|ingest|deep-ingest`) — it carries NO
 *     import-run semantics, so reusing it would mean overloading an unrelated
 *     channel. We do NOT invent a parallel channel either: we reuse the #423
 *     `useJobToast` consumer verbatim.
 *
 * Behaviour:
 *   - subscribes to the active run's lifecycle via {@link useJobToast}, which
 *     returns the latest event (for the live `<JobProgress>` bar) AND fires the
 *     terminal success/failure toast exactly once (the failure text is the
 *     server's already-generic, user-safe message — #254 / OWASP);
 *   - on the terminal transition, invalidates the import sources + runs caches so
 *     the page converges on PUSH. This demotes the 10s poll to a pure fallback:
 *     when the socket is connected, the refetch is driven by the event, not the
 *     timer; when it is disconnected, the poll still backstops convergence.
 */
import { useCallback } from "react";
import type { JobLifecycleEvent } from "@metis/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useJobToast } from "@/hooks/use-job-toast";
import { queryKeys } from "@/lib/query-keys";

export interface ImportProgressView {
  /** 0-100 when the total was known; null for an indeterminate bar. */
  progress: number | null;
  /** Human step/phase text for the current transition. */
  message: string;
  /** True while there is no known percentage to show (working, no number). */
  indeterminate: boolean;
  /** True once the run reached a terminal state (completed/failed). */
  done: boolean;
}

/**
 * Map a raw `import-sync` lifecycle event into the props the `<JobProgress>` bar
 * + status row render. Pure + exported so it is unit-tested without a socket.
 *
 * - `started`  → indeterminate "working" bar (no number yet).
 * - `progress` → determinate when the event carries a numeric `progress`
 *   (the server sends 0-100; 0 means "total unknown" → indeterminate so we never
 *   show a misleading "0%").
 * - `completed`/`failed` → done; the terminal toast (not the bar) communicates
 *   the outcome.
 */
export function importProgressView(event: JobLifecycleEvent | null): ImportProgressView | null {
  if (!event) return null;
  const done = event.status === "completed" || event.status === "failed";
  const hasPct =
    event.status === "progress" && typeof event.progress === "number" && event.progress > 0;
  return {
    progress: hasPct ? (event.progress as number) : null,
    message: event.message ?? (event.status === "started" ? "Importing…" : "Working…"),
    indeterminate: !done && !hasPct,
    done,
  };
}

/**
 * Subscribe to an active import run's progress and fire a terminal toast.
 *
 * @param runId     the active {@link ImportRun} id (= jobId), or null/undefined
 *                  when no run is in flight (subscribes to nothing).
 * @param projectId the project whose import caches to refresh on completion.
 * @returns the {@link ImportProgressView} for the live bar, or null when idle.
 */
export function useImportProgress(
  runId: string | null | undefined,
  projectId: string,
): ImportProgressView | null {
  const qc = useQueryClient();

  // On the terminal transition, refresh the import caches so the history list
  // reflects the final run status from PUSH — the 10s poll becomes a fallback.
  const onTerminal = useCallback(() => {
    void qc.invalidateQueries({ queryKey: queryKeys.imports.sources(projectId) });
    void qc.invalidateQueries({ queryKey: queryKeys.imports.runs(projectId) });
  }, [qc, projectId]);

  const event = useJobToast(runId, { onTerminal });
  return importProgressView(event);
}
