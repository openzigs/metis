"use client";

/**
 * Global terminal-toast consumer — Issue #425 (Epic #406, terminal layer).
 *
 * Closes the silent-failure gap for LIST-view users. doc-gen / analysis /
 * test-coverage write a failure to the row and emit `job:lifecycle failed`, but
 * the per-surface toasts added by #421–#424 only fire when that op's OWN detail
 * page is mounted. A user watching a project's documentation / analysis LIST
 * (which joins `project:{projectId}` via `useProjectJobEvents`, so its socket
 * already receives those events) therefore never learns the op failed.
 *
 * This hook attaches a SINGLE `job:lifecycle` listener to the shared socket
 * singleton — exactly like its sibling {@link useActiveJobs} — and fires the
 * canonical terminal toast for every `completed`/`failed` event the socket
 * receives. It joins NO new room (an Epic #406 invariant: `JobKind` is the
 * single chokepoint, no parallel channel); it simply observes whatever the
 * page-level hooks' room memberships already deliver.
 *
 * One-toast-per-op is guaranteed by {@link fireTerminalToast}'s module-level,
 * `jobId`-keyed dedup: whether this global layer or a detail surface
 * (`useJobToast`, the overview/Spec Kit/pr-review callbacks) observes the
 * terminal event first, only the first fires a toast. Success text comes from
 * `event.message` (preserving the Spec Kit grounded-completion line verbatim),
 * failure text from the server's already-generic `event.error` (#254 — no raw
 * error leak).
 *
 * Mount this ONCE, high in the tree (it lives in the header's
 * `ActiveJobsIndicator`, the same place the global active-jobs aggregator
 * mounts). Mounting it again elsewhere is harmless — the dedup makes duplicate
 * listeners idempotent — but unnecessary.
 *
 * The browser socket is loosely typed, so events are subscribed via the
 * `socket.on("name" as never, handler as never)` escape hatch used by the
 * sibling job-event hooks (`use-job-events.ts`, `use-active-jobs.ts`).
 */
import { useEffect } from "react";
import type { JobLifecycleEvent } from "@metis/shared";
import { useSocket } from "@/lib/socket-client";
import { fireTerminalToast } from "@/lib/terminal-toast";

/**
 * Subscribe the shared socket to the global `job:lifecycle` stream and fire the
 * deduped terminal toast on every terminal transition. Returns nothing — it is a
 * pure side-effect hook.
 */
export function useGlobalJobToasts(): void {
  const socket = useSocket();

  useEffect(() => {
    if (!socket) return;
    const onLifecycle = (data: JobLifecycleEvent) => {
      // `fireTerminalToast` ignores non-terminal/malformed events and dedupes by
      // jobId, so this stays a thin pass-through.
      fireTerminalToast(data);
    };
    socket.on("job:lifecycle" as never, onLifecycle as never);
    return () => {
      socket.off("job:lifecycle" as never, onLifecycle as never);
    };
  }, [socket]);
}
