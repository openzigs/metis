"use client";

/**
 * Global active-jobs aggregator — Epic #406 (#420).
 *
 * The unified job-events bus (#238/#239, widened by #419) broadcasts
 * `job:lifecycle` transitions for EVERY long-running op (analysis, doc-generation,
 * impact-analysis, scan, pr-review, import-sync, embeddings-reindex, spec-kit,
 * overview-regenerate). The doc detail / list views consume these per-job via
 * `useJobLifecycle` / `useDocSectionProgress`; this hook is the cross-cutting
 * consumer that powers the global "N jobs running" header indicator.
 *
 * Design — reuse the bus, add no new socket channel:
 *   - We attach a SINGLE `job:lifecycle` listener to the shared socket singleton.
 *     We do NOT subscribe to any new room: the listener simply observes every
 *     lifecycle event already delivered to this socket (the `project:{id}` and
 *     `job:{id}` rooms the page-level hooks join), exactly the same delivery the
 *     existing hooks rely on. There is intentionally no parallel progress channel
 *     (an Epic #406 invariant — `JobKind` is the single chokepoint).
 *   - Active jobs are tracked in a module-level, `useSyncExternalStore`-backed
 *     store keyed by `jobId`, so every consumer shares one source of truth and a
 *     job started on one surface is still counted after navigating away.
 *   - A job is "active" while its latest transition is `started` / `progress`.
 *     The moment it reaches a terminal state (`completed` / `failed`) it is
 *     removed, so the indicator clears when all jobs finish.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { JobKind, JobLifecycleEvent } from "@metis/shared";
import { useSocket } from "@/lib/socket-client";
import { joinJobRoom } from "@/lib/job-rooms";

/** A single in-flight job tracked for the global indicator. */
export interface ActiveJob {
  jobId: string;
  kind: JobKind;
  projectId: string | null;
  /** 0-100 completion when the bus provided it. */
  progress?: number;
  /** Latest human-readable step/message from the bus. */
  message?: string;
  /** Timestamp of the latest transition (used for stable ordering). */
  ts: number;
}

// ---- Module-level store (useSyncExternalStore-compatible) ------------------

const activeJobs = new Map<string, ActiveJob>();
const listeners = new Set<() => void>();
// A referentially-stable snapshot, only rebuilt when the map actually changes,
// so useSyncExternalStore does not loop on a fresh array every render.
let snapshot: ActiveJob[] = [];

function rebuildSnapshot(): void {
  // Stable order: oldest-first by timestamp, then jobId as a tiebreaker so the
  // drawer list does not jitter as progress events stream in.
  snapshot = Array.from(activeJobs.values()).sort(
    (a, b) => a.ts - b.ts || a.jobId.localeCompare(b.jobId),
  );
}

function emitChange(): void {
  rebuildSnapshot();
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ActiveJob[] {
  return snapshot;
}

const SERVER_SNAPSHOT: ActiveJob[] = [];
function getServerSnapshot(): ActiveJob[] {
  return SERVER_SNAPSHOT;
}

/** True when a lifecycle phase means the job is no longer running. */
function isTerminal(status: JobLifecycleEvent["status"]): boolean {
  return status === "completed" || status === "failed";
}

/**
 * Fold a single lifecycle event into the store. Terminal events remove the job;
 * `started`/`progress` upsert it. Exported for unit testing without a socket.
 */
export function applyJobLifecycleEvent(event: JobLifecycleEvent): void {
  if (!event || typeof event.jobId !== "string") return;
  if (isTerminal(event.status)) {
    if (activeJobs.delete(event.jobId)) emitChange();
    return;
  }
  // started / progress → upsert, preserving the most recent progress/message.
  const prev = activeJobs.get(event.jobId);
  activeJobs.set(event.jobId, {
    jobId: event.jobId,
    kind: event.kind,
    projectId: event.projectId,
    progress: typeof event.progress === "number" ? event.progress : prev?.progress,
    message: event.message ?? prev?.message,
    ts: event.ts,
  });
  emitChange();
}

/** Test-only reset so specs start from an empty store. Not used in production. */
export function __resetActiveJobsForTests(): void {
  activeJobs.clear();
  rebuildSnapshot();
  emitChange();
}

// ---- Human-readable labels -------------------------------------------------

/**
 * Friendly label for a job kind, shown in the drawer. Falls back to a
 * title-cased version of the raw kind so a brand-new `JobKind` still renders
 * sensibly without a code edit here.
 */
const KIND_LABELS: Record<JobKind, string> = {
  analysis: "Analysis",
  "doc-generation": "Documentation",
  "impact-analysis": "Impact analysis",
  scan: "Security scan",
  "pr-review": "PR review",
  "import-sync": "Import / sync",
  "embeddings-reindex": "Embeddings reindex",
  "spec-kit": "Spec Kit",
  "overview-regenerate": "Overview regenerate",
  "repo-ingest": "Repository deep ingest",
};

export function jobKindLabel(kind: JobKind): string {
  return (
    KIND_LABELS[kind] ??
    String(kind)
      .split("-")
      .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ")
  );
}

// ---- Public hooks ----------------------------------------------------------

/**
 * Subscribe the shared socket to the global `job:lifecycle` stream and aggregate
 * active jobs in the module store. Mount this ONCE high in the tree (the global
 * indicator) — the store is module-level, so calling it again elsewhere just
 * shares the same data. Returns the list of currently-active jobs (oldest-first).
 */
export function useActiveJobs(): ActiveJob[] {
  const socket = useSocket();
  const jobs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  useEffect(() => {
    if (!socket) return;
    const onLifecycle = (data: JobLifecycleEvent) => applyJobLifecycleEvent(data);
    // The browser socket is loosely typed; use the same escape hatch as the
    // sibling job-event hooks (use-job-events.ts).
    socket.on("job:lifecycle" as never, onLifecycle as never);
    return () => {
      socket.off("job:lifecycle" as never, onLifecycle as never);
    };
  }, [socket]);

  return jobs;
}

/**
 * #430 — how long `useFollowJobs` waits, once the socket is connected, for a
 * followed job's replay. The server remembers only the last 500 jobs and only in
 * memory, so an API restart or an eviction means no replay ever comes; without a
 * bound the stale `started` entry read as running until a page reload.
 *
 * Known trade-off (#465): the replay cache is bounded by `LAST_EVENT_CAP` (500),
 * so a job evicted from it is forgotten here too, even though it has not ended.
 * It comes back with its next `started`/`progress` event.
 */
export const REPLAY_WAIT_MS = 15_000;

/**
 * Drop a job the store can no longer account for. A later `started`/`progress`
 * event for it still re-adds it through `applyJobLifecycleEvent`.
 */
export function forgetActiveJob(jobId: string): void {
  if (activeJobs.delete(jobId)) emitChange();
}

/**
 * #273 — join each job's room so the server replays its last transition. A job
 * put into the store by the surface that started it (the New-project wizard)
 * may have ended before this page joined any room; the replay reaches the
 * `useActiveJobs` listener, which drops a terminal job from the store.
 *
 * #430 — a job that hears nothing within `REPLAY_WAIT_MS` of the socket being
 * connected is forgotten: the server has no record of it, so nothing would ever
 * end it. Rooms are joined through `joinJobRoom`, so unmounting here leaves
 * other followers of the same job on this socket in the room.
 *
 * #465 — a reconnect loses the socket's rooms on the server, so each connect
 * after the first re-subscribes and restarts the wait, and the clock is stopped
 * while the socket is down: nothing can be heard then, and a running job must
 * not be forgotten for it.
 *
 * #473 — intended consequence: after a deliberate `socket.disconnect()` with no
 * reconnect (a logout outside the renewal path), the clock stays stopped, so a
 * job the server lost stays listed until reload rather than being forgotten
 * after `REPLAY_WAIT_MS`. Keeping a finished job listed is the lesser mistake
 * than dropping one that may still be running.
 */
export function useFollowJobs(jobIds: readonly string[]): void {
  const socket = useSocket();
  const key = jobIds.join(",");
  useEffect(() => {
    if (!socket || !key) return;
    const ids = key.split(",");
    const heard = new Set<string>();
    const onLifecycle = (data: JobLifecycleEvent) => {
      if (data) heard.add(data.jobId);
    };
    socket.on("job:lifecycle" as never, onLifecycle as never);
    const leaves = ids.map((jobId) => joinJobRoom(socket, jobId));

    let timer: ReturnType<typeof setTimeout> | undefined;
    const startClock = () => {
      clearTimeout(timer);
      // Only a replay heard on this connection accounts for a job.
      heard.clear();
      timer = setTimeout(() => {
        for (const jobId of ids) if (!heard.has(jobId)) forgetActiveJob(jobId);
      }, REPLAY_WAIT_MS);
    };
    const stopClock = () => clearTimeout(timer);

    // Emits made before the socket connects are buffered and reach the server on
    // the first connect, so the replay cannot arrive until then; start the clock
    // on connect, not on mount. A later connect is a reconnect: the server has
    // dropped this socket's rooms, so re-join them. A re-join, not a new
    // follower — it leaves the `joinJobRoom` count alone, as in `useJobToast`.
    let joined = socket.connected;
    const onConnect = () => {
      if (joined) for (const jobId of ids) socket.emit("subscribe:job", { jobId });
      joined = true;
      startClock();
    };
    if (socket.connected) startClock();
    socket.on("connect" as never, onConnect as never);
    socket.on("disconnect" as never, stopClock as never);

    return () => {
      stopClock();
      socket.off("job:lifecycle" as never, onLifecycle as never);
      socket.off("connect" as never, onConnect as never);
      socket.off("disconnect" as never, stopClock as never);
      for (const leave of leaves) leave();
    };
  }, [socket, key]);
}
