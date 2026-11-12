/**
 * #2377 — a task failure that retrying cannot change.
 *
 * The queue retries a failed handler up to `maxAttempts` with backoff. That is
 * right for a timeout, a provider error or a busy database, and wasted work for
 * a failure decided by the task's own inputs: an automatic regeneration of a
 * document whose scope holds no documentable code fails the same way on every
 * attempt until something is ingested, and an ingest enqueues a fresh task
 * anyway. An error that sets `permanentTaskFailure: true` ends the task
 * `failed` on its first attempt.
 *
 * The check is on a property, not a class, so an error's own module (deep in
 * docs-gen, say) marks itself without importing the scheduler.
 */
export function isPermanentTaskFailure(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { permanentTaskFailure?: unknown }).permanentTaskFailure === true
  );
}
