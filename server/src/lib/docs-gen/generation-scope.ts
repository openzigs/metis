/**
 * #855 — the generation a piece of docs-gen work belongs to, found through an
 * AsyncLocalStorage scope opened by the route around one run.
 *
 * Kept separate from `generation-control.ts` (which owns the registry, the
 * cost ceiling and the provider wrapper) so `run-cost.ts` can report spend to
 * the run without importing the module that imports it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { RunUsageEvent } from "./run-cost.js";
import { UnpublishableGenerationError } from "./generation-checkpoint.js";

/** What docs-gen code may ask of the generation it runs inside. */
export interface GenerationScope {
  readonly docId: string;
  readonly projectId: string;
  /** Aborted when the run is cancelled, deleted, superseded or over its ceiling. */
  readonly signal: AbortSignal;
  /** Why the run was stopped, or `null` while it may continue. */
  stopError(): UnpublishableGenerationError | null;
  /** A model call that finished and was recorded (`noteRunUsage`). */
  noteSpend(event: RunUsageEvent): void;
}

const store = new AsyncLocalStorage<GenerationScope>();

/** Run `fn` with `scope` as the current generation for it and all its async work. */
export function withGenerationScope<T>(scope: GenerationScope, fn: () => Promise<T>): Promise<T> {
  return store.run(scope, fn);
}

/** The generation the caller runs inside, if any. */
export function currentGenerationScope(): GenerationScope | undefined {
  return store.getStore();
}

/**
 * Throw the run's stop error when it has been stopped. A no-op outside a
 * generation scope, so library code can call it unconditionally.
 */
export function throwIfGenerationStopped(): void {
  const stopped = store.getStore()?.stopError();
  if (stopped) throw stopped;
}

/**
 * True when `err` ends the whole run rather than one section or batch: a stop
 * the run itself decided ({@link UnpublishableGenerationError}), or any error
 * thrown after the current run was stopped (an aborted provider call surfaces
 * as a plain `AbortError`).
 */
export function isGenerationStop(err: unknown): boolean {
  return err instanceof UnpublishableGenerationError || store.getStore()?.stopError() != null;
}
