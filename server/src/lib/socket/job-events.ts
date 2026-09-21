/**
 * Unified job-lifecycle socket emitter — Epic #238 (#239), widened by #406 (#419).
 *
 * Broadcasts `started` / `progress` / `completed` / `failed` transitions for the
 * long-running flows over the EXISTING socket.io layer. No new realtime
 * dependency is introduced. As of Epic #406 (#419) the {@link JobKind} union
 * covers all long-running ops (analysis, doc-generation, impact-analysis, scan,
 * pr-review, import-sync, embeddings-reindex, spec-kit, overview-regenerate).
 *
 * THE EMIT SEAM (#420–#424 wire their op here, in one place):
 *   import { jobEvents, genericFailureMessage } from ".../socket/job-events.js";
 *   jobEvents.started(kind, jobId, projectId, message?);
 *   jobEvents.progress(kind, jobId, projectId, progress /* 0-100 *\/, message?);
 *   jobEvents.completed(kind, jobId, projectId, message?);   // progress pinned to 100
 *   jobEvents.failed(kind, jobId, projectId, genericFailureMessage(kind)); // #254: never raw err
 * `jobEvents` resolves the live IO server lazily via the registry, so callers
 * don't need `io` by DI. Pass `projectId: null` for cross-project jobs (the
 * `project:{id}` broadcast is then skipped). See `docs/ARCHITECTURE.md`
 * § "Realtime job-events bus" for the full contract.
 *
 * Rooms:
 *   - `job:{jobId}`        — a client watching one specific job.
 *   - `project:{projectId}` — a client watching a project surface (only when the
 *                             job is scoped to a single project; cross-project
 *                             jobs like multi-project impact analysis omit this).
 *
 * Emission is best-effort and fire-and-forget: a missing IO server (tests, CLI,
 * pre-bootstrap) or a transport error is swallowed and logged, never thrown into
 * the job's critical path. This mirrors the existing analysis orchestrator
 * `emit()` contract.
 */
import type { DocSectionProgressEvent, JobKind, JobLifecycleEvent } from "@metis/shared";
import { getSocketServer } from "./registry.js";
import type { MetisIOServer } from "./server.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("socket:job");

/** Input for a lifecycle emit — `ts` is filled in by the emitter. */
export type JobLifecycleInput = Omit<JobLifecycleEvent, "ts">;
export type DocSectionProgressInput = Omit<DocSectionProgressEvent, "ts">;

/**
 * Issue #254 — generic, user-safe failure messages broadcast on the `failed`
 * lifecycle event. Raw `err.message` is kept in server logs only (it can leak
 * stack hints, internal identifiers, and dependency errors); the socket payload
 * gets one of these stable, non-revealing strings instead.
 *
 * Epic #406 (#419) widened the bus to all long-running ops. Because this is a
 * `Record<JobKind, string>`, adding a new `JobKind` is a compile error until a
 * user-safe message is supplied here — keeping the #254 invariant total over the
 * whole union, not just the original three kinds.
 */
const GENERIC_FAILURE_MESSAGE: Record<JobKind, string> = {
  analysis: "Analysis failed",
  "doc-generation": "Document generation failed",
  "impact-analysis": "Impact analysis failed",
  // Epic #406 (#419) — new long-running ops.
  scan: "The scan failed. Please try again.",
  "pr-review": "The pull request review failed. Please try again.",
  "import-sync": "The import sync failed. Please try again.",
  "embeddings-reindex": "The embeddings reindex failed. Please try again.",
  "spec-kit": "The Spec Kit operation failed. Please try again.",
  "overview-regenerate": "The overview regeneration failed. Please try again.",
};

/**
 * Canonical, exhaustive list of every {@link JobKind}. Derived from the
 * `GENERIC_FAILURE_MESSAGE` keys so it can never drift out of sync with the
 * union: a new kind that lacks a failure message won't compile, and once added
 * it appears here automatically. Useful for iterating all kinds (tests, admin
 * surfaces) without re-listing the union.
 */
export const JOB_KINDS: readonly JobKind[] = Object.keys(GENERIC_FAILURE_MESSAGE) as JobKind[];

/**
 * Map a job kind to its user-safe failure message. Use this at every `failed`
 * emit site so raw error detail never reaches clients over the socket.
 */
export function genericFailureMessage(kind: JobKind): string {
  return GENERIC_FAILURE_MESSAGE[kind];
}

/**
 * The emitter surface. Returned by {@link createJobEventEmitter} and resolved on
 * demand by the module-level helpers so call sites can stay decoupled from IO
 * wiring (matching the `getSocketServer()` registry pattern from #728).
 */
export interface JobEventEmitter {
  /** Emit a job-lifecycle transition. */
  lifecycle(event: JobLifecycleInput): void;
  /** Convenience: emit a `started` transition. */
  started(kind: JobKind, jobId: string, projectId: string | null, message?: string): void;
  /** Convenience: emit a `progress` transition (0-100). */
  progress(
    kind: JobKind,
    jobId: string,
    projectId: string | null,
    progress: number,
    message?: string,
  ): void;
  /** Convenience: emit a `completed` transition. */
  completed(kind: JobKind, jobId: string, projectId: string | null, message?: string): void;
  /** Convenience: emit a `failed` transition. */
  failed(kind: JobKind, jobId: string, projectId: string | null, error: string): void;
  /** Emit a per-section doc-generation progress event (#243). */
  docSection(event: DocSectionProgressInput): void;
}

/** Build an emitter bound to a specific IO server (used in server bootstrap / tests). */
export function createJobEventEmitter(io: MetisIOServer | null): JobEventEmitter {
  const emitLifecycle = (event: JobLifecycleInput): void => {
    if (!io) return;
    const payload: JobLifecycleEvent = { ...event, ts: Date.now() };
    try {
      io.to(`job:${payload.jobId}`).emit("job:lifecycle", payload);
      if (payload.projectId) {
        io.to(`project:${payload.projectId}`).emit("job:lifecycle", payload);
      }
    } catch (err) {
      log.warn("job lifecycle emit failed", { error: (err as Error).message });
    }
  };

  const emitDocSection = (event: DocSectionProgressInput): void => {
    if (!io) return;
    const payload: DocSectionProgressEvent = { ...event, ts: Date.now() };
    try {
      io.to(`job:${payload.jobId}`).emit("job:doc-section", payload);
      io.to(`project:${payload.projectId}`).emit("job:doc-section", payload);
    } catch (err) {
      log.warn("job doc-section emit failed", { error: (err as Error).message });
    }
  };

  return {
    lifecycle: emitLifecycle,
    started: (kind, jobId, projectId, message) =>
      emitLifecycle({ kind, jobId, projectId, status: "started", message }),
    progress: (kind, jobId, projectId, progress, message) =>
      emitLifecycle({ kind, jobId, projectId, status: "progress", progress, message }),
    completed: (kind, jobId, projectId, message) =>
      emitLifecycle({ kind, jobId, projectId, status: "completed", progress: 100, message }),
    failed: (kind, jobId, projectId, error) =>
      emitLifecycle({ kind, jobId, projectId, status: "failed", error }),
    docSection: emitDocSection,
  };
}

/** Inert emitter for tests / when socket.io isn't wired. */
export const NOOP_JOB_EMITTER: JobEventEmitter = createJobEventEmitter(null);

/**
 * Module-level emitter that resolves the live IO server lazily via the registry.
 * Use this from job paths (routes, engines) that don't receive `io` by DI.
 */
export const jobEvents: JobEventEmitter = {
  lifecycle: (event) => createJobEventEmitter(getSocketServer()).lifecycle(event),
  started: (kind, jobId, projectId, message) =>
    createJobEventEmitter(getSocketServer()).started(kind, jobId, projectId, message),
  progress: (kind, jobId, projectId, progress, message) =>
    createJobEventEmitter(getSocketServer()).progress(kind, jobId, projectId, progress, message),
  completed: (kind, jobId, projectId, message) =>
    createJobEventEmitter(getSocketServer()).completed(kind, jobId, projectId, message),
  failed: (kind, jobId, projectId, error) =>
    createJobEventEmitter(getSocketServer()).failed(kind, jobId, projectId, error),
  docSection: (event) => createJobEventEmitter(getSocketServer()).docSection(event),
};
