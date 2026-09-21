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
 * Sets `notifiedAt` to prevent duplicate notifications.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { getSocketServer } from "../socket/registry.js";

const log = createChildLogger("collaboration:sla-checker");

/** Default poll interval: 5 minutes. */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;

export interface SlaCheckerHandle {
  stop(): void;
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

      // Notify the assignee.
      if (io) {
        io.to(`user:${assignment.assigneeId}`).emit("sla:deadline_expired", payload);
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
          },
        });
      } catch (persistErr) {
        log.warn("Failed to persist SLA notification for assignee", {
          assignmentId: assignment.id,
          userId: assignment.assigneeId,
          err: persistErr,
        });
      }

      // Notify the project coordinator if different from the assignee.
      const coordinatorId = assignment.requirement.project?.createdById;
      if (coordinatorId && coordinatorId !== assignment.assigneeId && io) {
        io.to(`user:${coordinatorId}`).emit("sla:deadline_expired", payload);

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
