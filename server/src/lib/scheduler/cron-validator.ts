/**
 * Strict cron-expression validation.
 *
 * Wraps `croner` for parsing + next-run computation. Rejects expressions
 * whose first two firings are closer together than `minIntervalSec` so a
 * fat-finger like `* * * * * *` (every second) cannot DOS the executor.
 */
import { Cron } from "croner";
import { SchedulerError } from "./types.js";

export interface CronValidation {
  expression: string;
  /** Detected interval between the next two scheduled firings, in ms. */
  intervalMs: number;
  /** Next scheduled run after `from`. */
  nextRun: Date;
}

/**
 * Validate a cron expression. Throws `SchedulerError` on bad syntax or when
 * the interval falls below `minIntervalSec`.
 *
 * `croner` accepts both 5- and 6-field expressions. A 6-field expression
 * (with seconds) trivially fires every second when authored as `* * * * * *`,
 * which is what the interval check guards against.
 */
export function validateCron(
  expression: string,
  opts: { minIntervalSec: number; from?: Date } = { minIntervalSec: 60 },
): CronValidation {
  const trimmed = (expression ?? "").trim();
  if (trimmed.length === 0) {
    throw new SchedulerError(400, "CRON_EMPTY", "cron expression is required");
  }
  let job: Cron;
  try {
    // `paused: true` keeps croner from registering the cron with the runtime;
    // we only need it to parse + compute next-runs.
    job = new Cron(trimmed, { paused: true }, () => {});
  } catch (err) {
    throw new SchedulerError(
      400,
      "CRON_INVALID",
      `cron expression is invalid: ${(err as Error).message}`,
    );
  }
  const from = opts.from ?? new Date();
  const next1 = job.nextRun(from);
  if (!next1) {
    throw new SchedulerError(400, "CRON_NO_FUTURE_RUNS", "cron expression yields no future runs");
  }
  const next2 = job.nextRun(next1);
  if (!next2) {
    throw new SchedulerError(
      400,
      "CRON_NO_FUTURE_RUNS",
      "cron expression yields fewer than two future runs",
    );
  }
  const intervalMs = next2.getTime() - next1.getTime();
  const minMs = opts.minIntervalSec * 1000;
  if (intervalMs < minMs) {
    throw new SchedulerError(
      400,
      "CRON_INTERVAL_TOO_SHORT",
      `cron interval ${Math.round(intervalMs / 1000)}s is below the minimum ${opts.minIntervalSec}s`,
    );
  }
  return { expression: trimmed, intervalMs, nextRun: next1 };
}

/**
 * Compute next run for a previously-validated expression. Returns `null` when
 * the expression has no future runs after `from`.
 */
export function nextRunOf(expression: string, from: Date = new Date()): Date | null {
  try {
    const job = new Cron(expression, { paused: true }, () => {});
    return job.nextRun(from) ?? null;
  } catch {
    return null;
  }
}
