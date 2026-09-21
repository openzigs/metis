/**
 * /api/tasks — Phase 11 routes (#79, #81).
 *
 *   GET    /                list tasks (filter status/jobType/projectId)  (task.read)
 *   GET    /:id             task detail                                   (task.read)
 *   POST   /:id/cancel      cancel a queued/running task                  (task.cancel)
 *   POST   /:id/retry       re-enqueue a failed/cancelled task            (task.retry)
 *
 * Authorization defence-in-depth: every list/get/cancel/retry response is
 * filtered through the actor's project-access set so a `task.read` token
 * cannot be used to enumerate other teams' tasks (review finding H3).
 * Denied access is audited (review finding L2).
 */
import { Router, type Request } from "express";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit/audit-service.js";
import { prisma } from "../lib/prisma.js";
import { fetchTaskRecord, getSchedulerBootstrap, SchedulerError } from "../lib/scheduler/index.js";
import {
  actorCanAccessProject,
  buildProjectAccessWhere,
  type SchedulerActor,
} from "../lib/scheduler/project-access.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actor(req: Request): SchedulerActor {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

function asAppError(err: unknown): unknown {
  if (err instanceof SchedulerError) return new AppError(err.status, err.code, err.message);
  return err;
}

const ALLOWED_STATUSES = new Set(["pending", "running", "completed", "failed", "cancelled"]);

export function tasksRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get("/", requirePermission("task.read"), async (req, res, next) => {
    try {
      const a = actor(req);
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const jobType = typeof req.query.jobType === "string" ? req.query.jobType : undefined;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const take = Math.min(Number.parseInt(String(req.query.take ?? "50"), 10) || 50, 200);
      const skip = Math.max(Number.parseInt(String(req.query.skip ?? "0"), 10) || 0, 0);
      if (status && !ALLOWED_STATUSES.has(status)) {
        throw new AppError(400, "INVALID_STATUS", `unknown status: ${status}`);
      }
      const accessWhere = await buildProjectAccessWhere(a);
      // If the caller asked for an explicit projectId outside their access
      // set, return an empty page rather than 403 (mirror the IDOR-mitigated
      // 404 strategy on the singular routes).
      if (projectId !== undefined) {
        const allowed = await actorCanAccessProject(a, projectId, {
          resource: "task-list",
          resourceId: projectId,
          action: "task.read",
        });
        if (!allowed) {
          res.json(ok({ items: [], total: 0 }));
          return;
        }
      }
      const where: Record<string, unknown> = {
        ...(status ? { status } : {}),
        ...(jobType ? { type: jobType } : {}),
        ...(projectId ? { projectId } : accessWhere),
      };
      const [items, total] = await Promise.all([
        prisma.task.findMany({
          where: where as never,
          orderBy: { createdAt: "desc" },
          take,
          skip,
        }),
        prisma.task.count({ where: where as never }),
      ]);
      res.json(ok({ items, total }));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.get("/:id", requirePermission("task.read"), async (req, res, next) => {
    try {
      const a = actor(req);
      const row = await prisma.task.findUnique({ where: { id: String(req.params.id) } });
      if (!row) throw new AppError(404, "TASK_NOT_FOUND", "task not found");
      const allowed = await actorCanAccessProject(a, row.projectId, {
        resource: "task",
        resourceId: row.id,
        action: "task.read",
      });
      if (!allowed) throw new AppError(404, "TASK_NOT_FOUND", "task not found");
      res.json(ok(row));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post("/:id/cancel", requirePermission("task.cancel"), async (req, res, next) => {
    try {
      const a = actor(req);
      const row = await prisma.task.findUnique({ where: { id: String(req.params.id) } });
      if (row) {
        const allowed = await actorCanAccessProject(a, row.projectId, {
          resource: "task",
          resourceId: row.id,
          action: "task.cancel",
        });
        if (!allowed) {
          // Hide existence behind a 409 like the not-cancellable path so
          // probing can't differentiate authorised from unauthorised tasks.
          throw new AppError(409, "TASK_NOT_CANCELLABLE", "task is not in a cancellable state");
        }
      }
      const { queue } = getSchedulerBootstrap();
      const cancelled = await queue.cancel(String(req.params.id), `cancelled by ${a.id}`);
      if (!cancelled) {
        audit({
          actor: { id: a.id },
          action: "task.cancel.denied",
          target: { type: "task", id: String(req.params.id) },
          metadata: { reason: "not-cancellable" },
        });
        throw new AppError(409, "TASK_NOT_CANCELLABLE", "task is not in a cancellable state");
      }
      res.status(202).json(ok({ ok: true }));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post("/:id/retry", requirePermission("task.retry"), async (req, res, next) => {
    try {
      const a = actor(req);
      const { queue } = getSchedulerBootstrap();
      const original = await fetchTaskRecord(String(req.params.id));
      if (!original) throw new AppError(404, "TASK_NOT_FOUND", "task not found");
      const allowed = await actorCanAccessProject(a, original.projectId, {
        resource: "task",
        resourceId: original.id,
        action: "task.retry",
      });
      if (!allowed) throw new AppError(404, "TASK_NOT_FOUND", "task not found");
      const retried = await queue.retry(String(req.params.id), original);
      res.status(202).json(ok({ taskId: retried.id, status: retried.status }));
    } catch (err) {
      next(asAppError(err));
    }
  });

  return r;
}
