/**
 * #1657 — a portfolio assessment runs only in the process that started it
 * (`void runAssessment` in `routes/portfolio-assessments.ts`), so a restart or
 * a crash leaves its row `pending` or `running` for ever, and a poller (#1626)
 * would wait on it indefinitely. A live run refreshes its row every
 * {@link PORTFOLIO_ASSESSMENT_HEARTBEAT_MS}; a sweep (now, then every
 * {@link PORTFOLIO_ASSESSMENT_SWEEP_INTERVAL_MS}) fails every row that has not
 * changed for {@link PORTFOLIO_ASSESSMENT_STALE_MS}. Failed, never resumed, as
 * for docs generation (#50) and Spec Kit jobs (#1059): a resumed run would
 * spend model calls nobody is waiting for. The starter sees `failed` and can
 * start it again.
 */
import { createChildLogger } from "../logger.js";
import { genericFailureMessage, jobEvents } from "../socket/job-events.js";
import { failInterruptedPortfolioAssessments } from "./assessment-store.js";

const log = createChildLogger("portfolio-assessment-sweep");
const KIND = "portfolio-assessment" as const;

/** How often a running assessment refreshes its row. */
export const PORTFOLIO_ASSESSMENT_HEARTBEAT_MS = 30_000;
/**
 * A `pending` or `running` row unchanged for this long has no process. Ten
 * missed beats, so a slow write or a long event-loop stall never fails a live run.
 */
export const PORTFOLIO_ASSESSMENT_STALE_MS = 5 * 60_000;
/** How often the sweep runs after its startup pass. */
export const PORTFOLIO_ASSESSMENT_SWEEP_INTERVAL_MS = 60_000;

/**
 * One sweep: fail the interrupted assessments, and (#1668) emit a `failed` job
 * event for each, as a run that fails in-process does, so a `job:{id}`
 * subscriber (#1626) hears it ended. Returns how many.
 */
export async function sweepInterruptedPortfolioAssessments(
  now: number = Date.now(),
): Promise<number> {
  const failed = await failInterruptedPortfolioAssessments(
    new Date(now - PORTFOLIO_ASSESSMENT_STALE_MS),
  );
  for (const id of failed) {
    jobEvents.failed(KIND, id, null, genericFailureMessage(KIND));
  }
  if (failed.length > 0) {
    log.warn("Failed interrupted portfolio assessments", { count: failed.length });
  }
  return failed.length;
}

/** Sweep now, then every `intervalMs`. Returns a stop function. */
export function startPortfolioAssessmentSweeper(
  intervalMs: number = PORTFOLIO_ASSESSMENT_SWEEP_INTERVAL_MS,
): () => void {
  const sweep = (): void => {
    sweepInterruptedPortfolioAssessments().catch((err: unknown) =>
      log.warn("Interrupted portfolio assessment sweep failed", { err: String(err) }),
    );
  };
  sweep();
  const timer = setInterval(sweep, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
