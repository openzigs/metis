/**
 * #399 / #432 / #449 — scheduling automatic document regeneration after an
 * ingest, told apart from a failure of the ingest itself.
 *
 * Every ingest entry point (Deep Ingest, the refresh-ingest route and the
 * scheduled repo refresh) schedules regeneration only once the ingest has landed.
 * If that scheduling then fails, the ingest still succeeded (#449, maintainer
 * decision): the caller reports success with a warning, and the scheduling step
 * alone is retried through a durable `schedule-regeneration` task, so the retry
 * never repeats the pull and ingest.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSchedulerBootstrap } from "../scheduler/index.js";
import { readTaskRecord } from "../scheduler/task-store.js";
import { tryAcquireConnectorIngest, connectorIngestHolder } from "../connectors/ingest-guard.js";
import { checkIncrementalRegeneration } from "./incremental.js";

const log = createChildLogger("docs-gen-regeneration-scheduling");

/**
 * Lease holders that schedule regeneration themselves when their ingest lands
 * (or report why not), so a pending retry can stand down for them (#498).
 */
const SELF_SCHEDULING_INGESTS = new Set([
  "auto-ingest",
  "deep-ingest",
  "refresh-ingest",
  "scheduled-refresh",
]);

/** The task that retries only the scheduling step (#449). */
export const SCHEDULE_REGENERATION_TASK = "schedule-regeneration";
export const SCHEDULE_REGENERATION_MAX_ATTEMPTS = 5;

/**
 * The warning a caller reports when scheduling failed and its retry is queued.
 * The underlying exception stays in the server log (#114, #254).
 */
export const REGENERATION_SCHEDULING_FAILED_MESSAGE =
  "The repository was ingested, but scheduling automatic document regeneration failed. " +
  "The details are in the server log; scheduling is retried automatically (up to " +
  `${SCHEDULE_REGENERATION_MAX_ATTEMPTS} times), without ingesting again.`;

/** The warning when the retry could not be queued either. */
export const REGENERATION_SCHEDULING_RETRY_UNAVAILABLE_MESSAGE =
  "The repository was ingested, but scheduling automatic document regeneration failed " +
  "and its retry could not be queued. The details are in the server log; " +
  "the next ingest of this repository retries it.";

export type RegenerationSchedulingOutcome =
  | { regenerationScheduled: true }
  | { regenerationScheduled: false; retryQueued: boolean; warning: string };

/**
 * A NEW scheduling failure re-arms the connector's retry row from any finished
 * state, including `cancelled`. That is not a resurrection of the cancelled
 * work (the `regenerate-generated-document` convention, ARCHITECTURE.md §34):
 * a cancel stops the attempt in flight, and a later ingest's failure is new
 * work. Leaving the row cancelled for good would make every later scheduled
 * refresh fall back to a full re-ingest, the outcome #449 removes (PR #491
 * panel).
 */
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"];

function retryTaskId(projectId: string, repoConnectorId: string): string {
  return `docs-regen-schedule:${projectId}:${repoConnectorId}`;
}

/**
 * Persist (or re-arm) the one retry task for this connector and hand it to the
 * queue. The row is the outbox: if the queue is not running in this process, the
 * scheduler's durable-task recovery picks the pending row up.
 */
async function queueSchedulingRetry(projectId: string, repoConnectorId: string): Promise<void> {
  const id = retryTaskId(projectId, repoConnectorId);
  const task = await prisma.task.upsert({
    where: { id },
    update: {},
    create: {
      id,
      projectId,
      type: SCHEDULE_REGENERATION_TASK,
      payload: JSON.stringify({ projectId, repoConnectorId }),
      maxAttempts: SCHEDULE_REGENERATION_MAX_ATTEMPTS,
    },
  });
  // A finished retry is re-armed by a new failure. Compare-and-set leaves a
  // pending or running retry alone.
  if (TERMINAL_STATUSES.includes(task.status)) {
    await prisma.task.updateMany({
      where: { id, status: task.status },
      data: {
        status: "pending",
        attempts: 0,
        startedAt: null,
        completedAt: null,
        errorMessage: null,
        progress: null,
        result: null,
      },
    });
  }
  const record = await readTaskRecord(id);
  if (record?.status !== "pending") return;
  try {
    getSchedulerBootstrap().queue.resume(record);
  } catch (err) {
    // The row is persisted; durable-task recovery dispatches it.
    log.warn("Scheduler not running here; the regeneration scheduling retry waits for recovery", {
      err,
      taskId: id,
    });
  }
}

/**
 * Schedule regeneration for a connector whose ingest has landed. Never throws:
 * a failure is logged with its cause, a retry of the scheduling step is queued,
 * and the outcome carries the warning the caller reports.
 */
export async function scheduleIncrementalRegeneration(
  projectId: string,
  repoConnectorId: string,
): Promise<RegenerationSchedulingOutcome> {
  try {
    await checkIncrementalRegeneration(projectId, repoConnectorId);
    return { regenerationScheduled: true };
  } catch (err) {
    log.warn("Ingest succeeded but scheduling regeneration failed; queueing a retry", {
      err,
      projectId,
      connectorId: repoConnectorId,
    });
  }
  try {
    await queueSchedulingRetry(projectId, repoConnectorId);
    return {
      regenerationScheduled: false,
      retryQueued: true,
      warning: REGENERATION_SCHEDULING_FAILED_MESSAGE,
    };
  } catch (err) {
    log.error("Could not queue the regeneration scheduling retry", {
      err,
      projectId,
      connectorId: repoConnectorId,
    });
    return {
      regenerationScheduled: false,
      retryQueued: false,
      warning: REGENERATION_SCHEDULING_RETRY_UNAVAILABLE_MESSAGE,
    };
  }
}

/**
 * The `schedule-regeneration` task body: run the scheduling step alone. Errors
 * propagate so the task queue retries with backoff. The connector must belong
 * to the task's project — the payload never widens scope — and a connector
 * deleted since leaves nothing to schedule, which is not worth a retry.
 *
 * #498 — the step runs under the connector's ingest lease, so a retry woken by
 * backoff never captures a partial input snapshot in the middle of a later
 * ingest. While an ingest holds the lease the retry stands down rather than
 * throwing: that ingest schedules regeneration itself when it lands, or reports
 * its failure and asks for another run. Throwing instead would spend the few
 * backoff attempts (seconds apart) against an ingest that runs for minutes.
 */
export async function retryRegenerationScheduling(
  projectId: string,
  repoConnectorId: string,
): Promise<void> {
  const connector = await prisma.repoConnection.findFirst({
    where: { id: repoConnectorId, projectId },
    select: { id: true },
  });
  if (!connector) {
    log.warn("Skipping the regeneration scheduling retry: repo connector not in this project", {
      projectId,
      connectorId: repoConnectorId,
    });
    return;
  }
  const lease = tryAcquireConnectorIngest(repoConnectorId, SCHEDULE_REGENERATION_TASK);
  if (!lease) {
    const holder = connectorIngestHolder(repoConnectorId);
    // Stand down only for an ingest that schedules regeneration (or reports
    // why not) when it lands. Any other holder -- the docs-gen eval runner's
    // bare source ingest -- never schedules, so standing down would drop this
    // retry for good; throw so the queue retries it with backoff (PR #505 review).
    if (holder !== null && SELF_SCHEDULING_INGESTS.has(holder)) {
      log.info(
        "Skipping the regeneration scheduling retry: an ingest is running and schedules it",
        {
          projectId,
          connectorId: repoConnectorId,
          holder,
        },
      );
      return;
    }
    log.warn("Regeneration scheduling retry deferred: the connector's lease is held", {
      projectId,
      connectorId: repoConnectorId,
      holder,
    });
    throw new Error(`regeneration scheduling retry deferred: connector lease held by ${holder}`);
  }
  try {
    await checkIncrementalRegeneration(projectId, repoConnectorId);
  } finally {
    lease.release();
  }
}
