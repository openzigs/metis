/**
 * #574 — how long a failed or cancelled Task stays retryable.
 *
 * `POST /tasks/:id/retry` re-enqueues a failed or cancelled Task from its own
 * stored payload. Nothing deletes Task rows, so without a limit every such Task
 * could be re-run for ever — and the vault secret an `http-webhook` payload
 * names (`authHeader`) had to stay live for ever with it (#495). The window
 * bounds both: once a terminal Task has not changed for this long, a retry is
 * refused and its payload no longer keeps a secret alive
 * (`isSecretReferenced`).
 *
 * Measured from `updatedAt`, which every status transition sets, so a row
 * written without `completedAt` is still bounded.
 */
export const TASK_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Statuses a Task can still run from without a retry. */
export const LIVE_TASK_STATUSES = ["pending", "running"] as const;

/** Terminal statuses `POST /tasks/:id/retry` accepts. */
export const RETRYABLE_TASK_STATUSES = ["failed", "cancelled"] as const;

/** The oldest `updatedAt` a failed or cancelled Task may have and still be retried. */
export function retryWindowCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TASK_RETRY_WINDOW_MS);
}

/** Is a failed or cancelled Task last changed at `updatedAt` still retryable? */
export function isWithinRetryWindow(updatedAt: Date, now: Date = new Date()): boolean {
  return updatedAt.getTime() >= retryWindowCutoff(now).getTime();
}
