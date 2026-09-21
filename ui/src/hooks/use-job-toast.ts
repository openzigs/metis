"use client";

/**
 * Job-lifecycle progress + terminal-toast consumer — Issue #423 (Epic #406).
 *
 * Three previously-blocking long ops (embeddings reindex, Spec Kit commands,
 * project overview regenerate) now stream `job:lifecycle` on the unified bus
 * under their own `JobKind` (`embeddings-reindex` / `spec-kit` /
 * `overview-regenerate`, added in #419). Each owns a single job id, so this hook
 * subscribes to ONE job's lifecycle (modelled on `useJobLifecycle` /
 * `useTaskProgress`) and:
 *   - exposes the latest event so the surface can render a live `<Progress>` bar
 *     / step text instead of a frozen "Running…" / "Regenerating…" label, and
 *   - fires a TERMINAL sonner toast exactly once per job: `success` on
 *     `completed` (using the event's human message — e.g. the Spec Kit
 *     grounded-completion line "Generated spec.md (v3) … grounded on 8 retrieved
 *     chunks."), and `error` on `failed` (using the event's already-generic,
 *     user-safe message — the server never sends raw error detail over the bus,
 *     #254 / OWASP).
 *
 * Authorization is NOT widened: we subscribe to the `job:{jobId}` room the
 * server already scopes; a project-scoped emit also fans out to
 * `project:{projectId}` which the page is already in. No new socket channel and
 * no parallel progress path — `JobKind` stays the single chokepoint (Epic #406).
 *
 * The browser socket is loosely typed, so events are subscribed via the
 * `socket.on("name" as never, handler as never)` escape hatch used elsewhere in
 * the UI (see `use-job-events.ts` / `use-task-progress.ts`).
 */
import { useEffect, useRef, useState } from "react";
import type { JobLifecycleEvent } from "@metis/shared";
import { useSocket } from "@/lib/socket-client";
import { fireTerminalToast, isTerminalJobStatus, terminalToastText } from "@/lib/terminal-toast";

// Re-exported from the canonical terminal-toast module (#425) so existing
// importers keep working. The toast text + terminal-status logic now lives in
// ONE place, shared with the global terminal-toast layer and — crucially — with
// the module-level dedup guard, so a job observed by BOTH this per-surface hook
// and the global layer fires exactly ONE toast (the per-instance `useRef` below
// can only dedup within a single component).
export { isTerminalJobStatus, terminalToastText };

export interface JobToastOptions {
  /**
   * Optional extra side effect fired once per terminal transition AFTER the
   * toast (e.g. invalidate a query, clear a local pending flag). Receives the
   * terminal lifecycle event.
   */
  onTerminal?: (event: JobLifecycleEvent) => void;
}

/**
 * Subscribe to a single job's lifecycle and fire a terminal success/failure
 * toast. Returns the latest lifecycle event (or null) so the caller can drive a
 * progress bar / step text.
 *
 * Pass `null`/`undefined` for `jobId` (e.g. before the op is launched) to
 * subscribe to nothing and get `null` back — so callers can use it
 * unconditionally without violating the rules of hooks.
 */
export function useJobToast(
  jobId: string | null | undefined,
  options: JobToastOptions = {},
): JobLifecycleEvent | null {
  const socket = useSocket();
  const [event, setEvent] = useState<JobLifecycleEvent | null>(null);

  // Keep the latest `onTerminal` in a ref so a fresh closure each render does
  // not force a re-subscribe (which would thrash the socket room).
  const onTerminalRef = useRef(options.onTerminal);
  onTerminalRef.current = options.onTerminal;

  // Per-instance guard for the caller's `onTerminal` SIDE EFFECT (cache refresh,
  // clearing a pending flag). This is intentionally separate from the toast
  // dedup: the toast is deduped app-wide via `fireTerminalToast`, but the side
  // effect must still run for THIS surface on its first terminal transition even
  // if the global layer fired the (single) toast first. Without this split, a
  // global-layer-wins race would skip the surface's cache invalidation.
  const sideEffectFiredRef = useRef<string | null>(null);

  useEffect(() => {
    if (!socket || !jobId) {
      setEvent(null);
      return;
    }
    // Reset when switching jobs so a previous job's progress never leaks.
    setEvent(null);
    sideEffectFiredRef.current = null;
    socket.emit("subscribe:job", { jobId });

    const onLifecycle = (data: JobLifecycleEvent) => {
      if (data.jobId !== jobId) return;
      setEvent(data);
      if (isTerminalJobStatus(data.status)) {
        // Toast: app-wide dedup (this hook + the global layer + bus re-delivery
        // all collapse to ONE toast per job).
        fireTerminalToast(data);
        // Side effect: per-instance dedup so it runs exactly once for THIS
        // surface regardless of who won the toast race.
        if (sideEffectFiredRef.current !== data.jobId) {
          sideEffectFiredRef.current = data.jobId;
          onTerminalRef.current?.(data);
        }
      }
    };

    socket.on("job:lifecycle" as never, onLifecycle as never);
    return () => {
      socket.emit("unsubscribe:job", { jobId });
      socket.off("job:lifecycle" as never, onLifecycle as never);
    };
  }, [socket, jobId]);

  return event;
}
