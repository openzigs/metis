/**
 * Issue #1021 — run-scoped PROJECT attribution for impact-analysis LLM metering.
 *
 * The impact pipeline's LLM stages are injected into the engine as collaborators
 * that were bound to a provider ONCE, at run-deps construction time (see
 * `routes/impact-analysis.ts`). Three of the six — the #936 table filter, the
 * #1001 additive-DDL proposer and the #932 summarizer — receive no `projectId`
 * at call time, so a provider decorator has no explicit channel through which to
 * learn which project's budget the call should be billed to.
 *
 * Rather than widen four collaborator signatures (and force every existing test
 * double to grow a parameter it does not use), the engine publishes the project
 * it is currently working on into an {@link AsyncLocalStorage} scope, and the
 * metering decorator reads it. That has two properties worth the indirection:
 *
 *   - it is correct across `await` boundaries and would stay correct if the
 *     engine ever processed projects concurrently (a mutable module-level
 *     "current project" would silently mis-attribute in that case); and
 *   - a stage added later is attributed automatically, with no new plumbing —
 *     which is the specific regression #1021 asks us to make impossible.
 *
 * This module is deliberately dependency-free (no Prisma, no token tracker) so
 * the engine can import it without pulling the metering stack into its test
 * graph.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface ImpactProjectScope {
  readonly projectId: string | null;
}

const storage = new AsyncLocalStorage<ImpactProjectScope>();

/**
 * Run `fn` with `projectId` published as the current impact-analysis project.
 * `null` is a legitimate value: the run-level overview summarizer spans every
 * project in a multi-project run and belongs to none of them.
 */
export function runInImpactProjectScope<T>(projectId: string | null, fn: () => T): T {
  return storage.run({ projectId }, fn);
}

/**
 * Re-point the ALREADY-ACTIVE scope at `projectId` for the remainder of the
 * current async flow.
 *
 * The engine's project loop is ~250 lines of existing code; re-indenting it into
 * a `runInImpactProjectScope` callback would bury the behavioural change of this
 * issue in a whitespace diff. `enterWith` expresses the same thing in one line
 * per iteration. `executeImpactAnalysis` wraps its whole body in a
 * {@link runInImpactProjectScope} so these transitions can never escape the run
 * and leak into the caller's context.
 */
export function enterImpactProjectScope(projectId: string | null): void {
  storage.enterWith({ projectId });
}

/** The project an impact LLM call should be billed to, or `null` outside a scope. */
export function currentImpactProjectId(): string | null {
  return storage.getStore()?.projectId ?? null;
}
