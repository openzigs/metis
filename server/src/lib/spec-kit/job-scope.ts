/**
 * #1059 — the Spec Kit job a piece of command code runs inside, found through
 * an AsyncLocalStorage scope the job runner opens around one command (the same
 * shape as docs-gen's `generation-scope.ts`, #855).
 *
 * Kept free of the database and of the job runner so the artifact stores and
 * the command runner can ask it three things without an import cycle:
 *
 *   - "has this job been stopped?" before a model call
 *     ({@link throwIfSpecKitJobStopped}), with the job's `AbortSignal` passed to
 *     the call itself;
 *   - "may I start saving?" before an artifact write
 *     ({@link specKitJobCommitPoint});
 *   - "this is what I am doing now" ({@link reportSpecKitJobPhase}).
 *
 * Outside a job (a manual edit, a command that is not a job, a unit test of a
 * command) all three are no-ops.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/** Why a job was stopped before it saved anything. */
export type SpecKitJobStopReason = "cancelled" | "timeout" | "superseded";

const STOP_TEXT: Readonly<Record<SpecKitJobStopReason, string>> = {
  cancelled: "The Spec Kit command was cancelled",
  timeout: "The Spec Kit command ran past its time limit",
  superseded: "The Spec Kit job no longer owns its run",
};

/** Thrown inside a stopped job; the runner turns it into the job's outcome. */
export class SpecKitJobStopError extends Error {
  constructor(readonly reason: SpecKitJobStopReason) {
    super(STOP_TEXT[reason]);
    this.name = "SpecKitJobStopError";
  }
}

/** What command code may ask of the job it runs inside. */
export interface SpecKitJobScope {
  readonly jobId: string;
  readonly projectId: string;
  /** Aborted when the job is stopped (cancel, time limit, lost ownership). */
  readonly signal: AbortSignal;
  /** Why the job was stopped, or `null` while it may continue. */
  stopError(): SpecKitJobStopError | null;
  /**
   * The job is about to write an artifact. Before its FIRST write this moves
   * the job's row `running` → `saving` in the database, which succeeds only
   * while the row is still this job's: a job that was cancelled, timed out or
   * failed by another replica's sweep is refused here, throws its stop error
   * and writes nothing. Before each later write it re-checks that the row is
   * still its own. Once `saving`, a job can no longer be cancelled or timed
   * out, so a command that writes several artifacts writes all of them.
   */
  commitPoint(): Promise<void>;
  /** What the job is doing now; `progress` is 0-100 when the command knows it. */
  phase(text: string, progress?: number): void;
}

const store = new AsyncLocalStorage<SpecKitJobScope>();

/** Run `fn` with `scope` as the current Spec Kit job for it and all its async work. */
export function withSpecKitJobScope<T>(scope: SpecKitJobScope, fn: () => Promise<T>): Promise<T> {
  return store.run(scope, fn);
}

/** The Spec Kit job the caller runs inside, if any. */
export function currentSpecKitJob(): SpecKitJobScope | undefined {
  return store.getStore();
}

/** Throw the job's stop error when it has been stopped. A no-op outside a job. */
export function throwIfSpecKitJobStopped(): void {
  const stopped = store.getStore()?.stopError();
  if (stopped) throw stopped;
}

/** See {@link SpecKitJobScope.commitPoint}. A no-op outside a job. */
export async function specKitJobCommitPoint(): Promise<void> {
  await store.getStore()?.commitPoint();
}

/** See {@link SpecKitJobScope.phase}. A no-op outside a job. */
export function reportSpecKitJobPhase(text: string, progress?: number): void {
  store.getStore()?.phase(text, progress);
}
