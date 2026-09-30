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
 * Measured from when the Task ENDED — `completedAt`, which `markFailed` and
 * `markCancelled` stamp and nothing else rewrites — not from `updatedAt`, which
 * any later write to the row resets (`@updatedAt`), so anchoring on it would let
 * an unrelated write to a finished Task (a payload rewrite, a progress update)
 * silently reopen the window. `updatedAt` is only the fallback for a terminal
 * row written without `completedAt`, so that row is still bounded.
 */
export const TASK_RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Statuses a Task can still run from without a retry. */
export const LIVE_TASK_STATUSES = ["pending", "running"] as const;

/** Terminal statuses `POST /tasks/:id/retry` accepts. */
export const RETRYABLE_TASK_STATUSES = ["failed", "cancelled"] as const;

/** The earliest end time a failed or cancelled Task may have and still be retried. */
export function retryWindowCutoff(now: Date = new Date()): Date {
  return new Date(now.getTime() - TASK_RETRY_WINDOW_MS);
}

/** The timestamps the window is measured from. */
export interface TaskEndTimes {
  completedAt: Date | null;
  updatedAt: Date;
}

/** When a terminal Task ended: `completedAt`, falling back to `updatedAt` only when it is unset. */
export function retryWindowAnchor(task: TaskEndTimes): Date {
  return task.completedAt ?? task.updatedAt;
}

/** Is a failed or cancelled Task still retryable? */
export function isWithinRetryWindow(task: TaskEndTimes, now: Date = new Date()): boolean {
  return retryWindowAnchor(task).getTime() >= retryWindowCutoff(now).getTime();
}
