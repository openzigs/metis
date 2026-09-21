/**
 * Monthly chargeback cron scheduler (Epic #47 / Issue #52).
 *
 * Runs `runMonthlyChargeback` on the cron schedule `0 6 1 * *` (06:00 UTC on
 * the 1st of every month) using `croner` — the same cron engine the platform
 * scheduler already depends on. Returns a handle whose `stop()` cancels the
 * job, mirroring the SLA-checker / forecast-recompute lifecycle.
 */
import { Cron } from "croner";
import { createChildLogger } from "../logger.js";
import { runMonthlyChargeback, type GenerateAndSendOptions } from "./chargeback-report.js";

const log = createChildLogger("finops-chargeback-scheduler");

/** AC: monthly chargeback runs at 06:00 on the 1st of each month (UTC). */
export const CHARGEBACK_CRON = "0 6 1 * *";

export interface ChargebackSchedulerHandle {
  stop(): void;
  /** Next scheduled run (for diagnostics / tests). */
  nextRun(): Date | null;
}

export function startChargebackScheduler(
  opts: GenerateAndSendOptions = {},
  cronExpr = CHARGEBACK_CRON,
): ChargebackSchedulerHandle {
  const job = new Cron(cronExpr, { timezone: "UTC" }, () => {
    runMonthlyChargeback(new Date(), opts).catch((err) => {
      log.error("monthly chargeback run failed", { error: (err as Error).message });
    });
  });
  log.info("chargeback scheduler started", {
    cron: cronExpr,
    nextRun: job.nextRun()?.toISOString(),
  });
  return {
    stop() {
      job.stop();
      log.info("chargeback scheduler stopped");
    },
    nextRun() {
      return job.nextRun() ?? null;
    },
  };
}
