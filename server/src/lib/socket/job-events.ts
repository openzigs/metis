/**
 * Unified job-lifecycle socket emitter — Epic #238 (#239), widened by #406 (#419).
 *
 * Broadcasts `started` / `progress` / `completed` / `failed` transitions for the
 * long-running flows over the EXISTING socket.io layer. No new realtime
 * dependency is introduced. As of Epic #406 (#419) the {@link JobKind} union
 * covers all long-running ops (analysis, doc-generation, impact-analysis,
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
import {
  jobRoom,
  projectRoom,
  type DocSectionProgressEvent,
  type JobKind,
  type JobLifecycleEvent,
} from "@metis/shared";
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
  "pr-review": "The pull request review failed. Please try again.",
  "import-sync": "The import sync failed. Please try again.",
  "embeddings-reindex": "The embeddings reindex failed. Please try again.",
  "spec-kit": "The Spec Kit operation failed. Please try again.",
  "overview-regenerate": "The overview regeneration failed. Please try again.",
  // #373 — a repository connector's Deep Ingest, run in the background.
  "repo-ingest":
    "Repository ingestion failed. The details are in the server log; run the ingest again to retry.",
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

/**
 * Last lifecycle event per job, so a client that subscribes AFTER an event was
 * broadcast can still learn where the job got to.
 *
 * A socket room only delivers what is emitted while you are in it. The UI
 * subscribes to `job:{id}` after the trigger endpoint answers, so a job that
 * starts (or finishes) inside that window emitted into an empty room and the
 * surface sat on its "Running…" label forever — the embeddings reindex, whose
 * whole run can be shorter than the round-trip, hit this every time.
 *
 * Bounded so a long-lived server cannot grow this without limit: insertion
 * order is preserved by `Map`, so the oldest entry is the first key.
 */
const LAST_EVENT_CAP = 500;
const lastLifecycleByJob = new Map<string, JobLifecycleEvent>();

/**
 * #655 — the scope a `job:{id}` room join is authorized against: the job's
 * kind and project, taken from every event emitted for it and from
 * {@link rememberJobScope} for an id handed out before its first event (a
 * queued PR review).
 *
 * Two stores, each bounded on {@link LAST_EVENT_CAP} with least-recently-touched
 * eviction. Event-derived scopes share the lifecycle memory's churn; a scope
 * recorded by `rememberJobScope` lives in its own store, so a PR review that
 * waits in the queue behind 500 other jobs' events is still authorizable when
 * its first event (or its client's `subscribe:job`) arrives. Only another 500
 * remembered ids evict it — the bound on hand-outs before a first event.
 */
export interface JobScope {
  kind: JobKind;
  projectId: string | null;
}
const eventJobScopeById = new Map<string, JobScope>();
const rememberedJobScopeById = new Map<string, JobScope>();

function storeJobScope(store: Map<string, JobScope>, jobId: string, scope: JobScope): void {
  store.delete(jobId);
  store.set(jobId, scope);
  while (store.size > LAST_EVENT_CAP) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/**
 * Record a job's scope when its id is handed to a client before any event has
 * been emitted for it, so the client's `subscribe:job` can be authorized.
 */
export function rememberJobScope(jobId: string, kind: JobKind, projectId: string | null): void {
  storeJobScope(rememberedJobScopeById, jobId, { kind, projectId });
}

/** The remembered scope of a job, or `undefined` when this process has none. */
export function getJobScope(jobId: string): JobScope | undefined {
  return eventJobScopeById.get(jobId) ?? rememberedJobScopeById.get(jobId);
}

function rememberLifecycle(event: JobLifecycleEvent): void {
  storeJobScope(eventJobScopeById, event.jobId, { kind: event.kind, projectId: event.projectId });
  // Re-insert so the most recently touched job is the newest key.
  lastLifecycleByJob.delete(event.jobId);
  lastLifecycleByJob.set(event.jobId, event);
  while (lastLifecycleByJob.size > LAST_EVENT_CAP) {
    const oldest = lastLifecycleByJob.keys().next();
    if (oldest.done) break;
    lastLifecycleByJob.delete(oldest.value);
  }
}

/**
 * The most recent lifecycle event broadcast for a job, or `undefined` when the
 * job is unknown to this process. Used by the socket server to replay state to
 * a late subscriber.
 */
export function getLastJobLifecycle(jobId: string): JobLifecycleEvent | undefined {
  return lastLifecycleByJob.get(jobId);
}

/**
 * #510 — latest `job:doc-section` event per section, per job, so a subscriber
 * that was away while a section moved (a reconnect drops the socket's rooms)
 * can be brought up to date on `subscribe:job`, not only on the lifecycle.
 * A `started` lifecycle event for the job clears it, so a new run on a reused
 * job id does not inherit the last run's sections.
 * Bounded by job on the same cap and eviction order as the lifecycle memory;
 * a document has a handful of sections, so each job's inner map stays small.
 */
const lastDocSectionsByJob = new Map<string, Map<string, DocSectionProgressEvent>>();

function rememberDocSection(event: DocSectionProgressEvent): void {
  if (!eventJobScopeById.has(event.jobId)) {
    storeJobScope(eventJobScopeById, event.jobId, {
      kind: "doc-generation",
      projectId: event.projectId,
    });
  }
  const sections = lastDocSectionsByJob.get(event.jobId) ?? new Map();
  sections.set(event.section, event);
  lastDocSectionsByJob.delete(event.jobId);
  lastDocSectionsByJob.set(event.jobId, sections);
  while (lastDocSectionsByJob.size > LAST_EVENT_CAP) {
    const oldest = lastDocSectionsByJob.keys().next();
    if (oldest.done) break;
    lastDocSectionsByJob.delete(oldest.value);
  }
}

/**
 * The latest doc-section event for each section of a job, in the order the
 * sections first reported, or an empty array when the job is unknown.
 */
export function getLastDocSections(jobId: string): DocSectionProgressEvent[] {
  return [...(lastDocSectionsByJob.get(jobId)?.values() ?? [])];
}

/** Test seam — drop the remembered events. */
export function _resetJobLifecycleMemory(): void {
  lastLifecycleByJob.clear();
  lastDocSectionsByJob.clear();
  eventJobScopeById.clear();
  rememberedJobScopeById.clear();
}

/** Build an emitter bound to a specific IO server (used in server bootstrap / tests). */
export function createJobEventEmitter(io: MetisIOServer | null): JobEventEmitter {
  const emitLifecycle = (event: JobLifecycleInput): void => {
    const payload: JobLifecycleEvent = { ...event, ts: Date.now() };
    // A new run can reuse a job id (regenerating a document keys the job by
    // the doc id), so its sections start fresh rather than replaying the
    // previous run's terminal states (#510 review).
    if (payload.status === "started") lastDocSectionsByJob.delete(payload.jobId);
    // Remember BEFORE the transport check: a late subscriber must be able to
    // catch up even on a server whose emit failed or that had no io at the time.
    rememberLifecycle(payload);
    if (!io) return;
    try {
      io.to(jobRoom(payload.jobId)).emit("job:lifecycle", payload);
      if (payload.projectId) {
        io.to(projectRoom(payload.projectId)).emit("job:lifecycle", payload);
      }
    } catch (err) {
      log.warn("job lifecycle emit failed", { error: (err as Error).message });
    }
  };

  const emitDocSection = (event: DocSectionProgressInput): void => {
    const payload: DocSectionProgressEvent = { ...event, ts: Date.now() };
    // Remember before the transport check, as the lifecycle does (#510).
    rememberDocSection(payload);
    if (!io) return;
    try {
      io.to(jobRoom(payload.jobId)).emit("job:doc-section", payload);
      io.to(projectRoom(payload.projectId)).emit("job:doc-section", payload);
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
