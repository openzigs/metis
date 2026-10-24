/**
 * Epic #728 / Issue #736 — SLA deadline notification checker.
 *
 * Runs on a configurable interval (default 5 min). For each Assignment where:
 *   - slaDeadline < now()
 *   - resolvedAt IS NULL (not yet completed)
 *   - notifiedAt IS NULL (not yet notified)
 *
 * It fans out an `sla:deadline_expired` Socket.IO event to:
 *   1. The assignee's personal room (`user:{assigneeId}`)
 *   2. The project coordinator's personal room (`user:{project.createdById}`)
 *      — only when different from the assignee.
 *
 * Each recipient must still be able to open the requirement's project (#1432,
 * `isEligibleAssignee`); one who cannot is skipped, and the row is still marked.
 * If that check fails (a DB error), the row is neither sent nor marked, so the
 * next run retries it.
 *
 * Sets `notifiedAt` to prevent duplicate notifications.
 */
import { userRoom } from "@metis/shared";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";
import { isEligibleAssignee } from "../requirements/assignee-eligibility.js";

const log = createChildLogger("collaboration:sla-checker");

/** Default poll interval: 5 minutes. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;

export interface SlaCheckerHandle {
  stop(): void;
}

/**
 * Whether a recipient may be told about a requirement: `"unknown"` when the
 * check itself failed, which is not the same answer as `"ineligible"`.
 */
export type RecipientStatus = "eligible" | "ineligible" | "unknown";

/**
 * May `userId` be told about a requirement in `projectId`? The assignee rule
 * (#1432). A lookup error is `"unknown"`: the caller sends nothing (never risk
 * a title to someone who cannot open the project) and leaves the row unmarked,
 * so the next run retries instead of dropping a legitimate reminder for good.
 */
async function recipientStatus(userId: string, projectId: string): Promise<RecipientStatus> {
  try {
    return (await isEligibleAssignee(userId, projectId)) ? "eligible" : "ineligible";
  } catch (err) {
    log.warn("SLA recipient check failed; will retry next run", { userId, projectId, err });
    return "unknown";
  }
}

/**
 * Check for overdue SLA assignments and emit notifications.
 * Exported for direct use in unit tests.
 */
export async function runSlaCheck(): Promise<void> {
  const now = new Date();

  const overdueAssignments = await prisma.assignment.findMany({
    where: {
      slaDeadline: { lt: now },
      resolvedAt: null,
      notifiedAt: null,
    },
    select: {
      id: true,
      assigneeId: true,
      slaDeadline: true,
      requirement: {
        select: {
          id: true,
          title: true,
          projectId: true,
          project: { select: { createdById: true } },
        },
      },
    },
  });

  if (overdueAssignments.length === 0) return;

  const io = getSocketServer();

  for (const assignment of overdueAssignments) {
    try {
      const payload = {
        assignmentId: assignment.id,
        requirementId: assignment.requirement.id,
        requirementTitle: assignment.requirement.title,
        slaDeadline: assignment.slaDeadline?.toISOString(),
        ts: Date.now(),
      };

      const projectId = assignment.requirement.projectId;
      const coordinatorId = assignment.requirement.project?.createdById;
      const notifyCoordinator = !!coordinatorId && coordinatorId !== assignment.assigneeId && !!io;

      // Each recipient only while they can still open the project (#1432): the
      // payload carries the requirement title, and the row may predate assignee
      // checks or outlive a recipient's membership. Both are decided BEFORE any
      // send, so a row is either handled whole or left whole for the next run.
      const [assigneeStatus, coordinatorStatus] = await Promise.all([
        recipientStatus(assignment.assigneeId, projectId),
        notifyCoordinator
          ? recipientStatus(coordinatorId, projectId)
          : Promise.resolve<RecipientStatus>("ineligible"),
      ]);
      if (assigneeStatus === "unknown" || coordinatorStatus === "unknown") {
        // Not sent, not marked: retried on the next tick.
        continue;
      }

      if (assigneeStatus === "eligible") {
        if (io) {
          io.to(userRoom(assignment.assigneeId)).emit("sla:deadline_expired", payload);
        }

        // Issue #416 — persist SLA notification for the assignee. Best-effort.
        try {
          await prisma.notification.create({
            data: {
              userId: assignment.assigneeId,
              type: "sla_deadline",
              title: `SLA deadline expired: ${assignment.requirement.title}`,
              message: `Assignment ${assignment.id} SLA deadline has passed`,
              href: `/requirements/${encodeURIComponent(assignment.requirement.id)}`,
              payload: JSON.stringify(payload),
              // #1447 — so every read re-checks the reader's access to it.
              projectId,
            },
          });
        } catch (persistErr) {
          log.warn("Failed to persist SLA notification for assignee", {
            assignmentId: assignment.id,
            userId: assignment.assigneeId,
            err: persistErr,
          });
        }
      }

      // Notify the project coordinator if different from the assignee (and,
      // like the assignee, still able to open the project — #1432).
      if (notifyCoordinator && coordinatorStatus === "eligible" && io && coordinatorId) {
        io.to(userRoom(coordinatorId)).emit("sla:deadline_expired", payload);

        // Issue #416 — persist SLA notification for the coordinator too.
        try {
          await prisma.notification.create({
            data: {
              userId: coordinatorId,
              type: "sla_deadline",
              title: `SLA deadline expired: ${assignment.requirement.title}`,
              message: `Assignment ${assignment.id} SLA deadline has passed`,
              href: `/requirements/${encodeURIComponent(assignment.requirement.id)}`,
              payload: JSON.stringify(payload),
              // #1447 — so every read re-checks the reader's access to it.
              projectId,
            },
          });
        } catch (persistErr) {
          log.warn("Failed to persist SLA notification for coordinator", {
            assignmentId: assignment.id,
            userId: coordinatorId,
            err: persistErr,
          });
        }
      }

      // Mark as notified so we don't re-notify on the next tick.
      await prisma.assignment.update({
        where: { id: assignment.id },
        data: { notifiedAt: new Date() },
      });
    } catch (err) {
      log.warn("Failed to process SLA notification for assignment", {
        assignmentId: assignment.id,
        err,
      });
    }
  }
}

/**
 * Start the SLA checker interval.
 * Returns a handle with a `stop()` method for graceful shutdown.
 *
 * @param intervalMs  Poll interval in milliseconds (default 5 min).
 */
export function startSlaChecker(intervalMs = DEFAULT_INTERVAL_MS): SlaCheckerHandle {
  const timer = setInterval(() => {
    runSlaCheck().catch((err) => {
      log.error("SLA checker run failed", { err });
    });
  }, intervalMs);

  // Allow the Node.js event loop to exit even if the timer is still pending.
  if (typeof timer.unref === "function") timer.unref();

  log.info("SLA checker started", { intervalMs });

  return {
    stop() {
      clearInterval(timer);
      log.info("SLA checker stopped");
    },
  };
}
