/**
 * /api/scheduler — Phase 11 routes (#77, #78, #80, #82).
 *
 *   GET    /             list jobs (filter by projectId)               (scheduler.read)
 *   POST   /             create a job                                  (scheduler.manage)
 *   GET    /handlers     list registered task types                    (scheduler.read)
 *   GET    /:id          job detail                                    (scheduler.read)
 *   PATCH  /:id          update                                        (scheduler.manage)
 *   DELETE /:id          soft-delete                                   (scheduler.manage)
 *   POST   /:id/run      manual trigger (rate-limited)                 (scheduler.manage)
 *   POST   /:id/pause    disable                                       (scheduler.manage)
 *   POST   /:id/resume   enable                                        (scheduler.manage)
 *   GET    /:id/history  recent task runs (last 50)                    (scheduler.read)
 *
 * Authorization is layered:
 *   - `requireAuth` extracts JWT into `req.user`.
 *   - `requirePermission` enforces the role-permission map at the route layer.
 *   - The scheduler service runs the project-access guard a second time so
 *     callers (handlers, CLI, jobs) cannot bypass it (review finding H1).
 *   - `runNowRateLimiter` caps manual triggers per user (review finding M4).
 */
import { Router, type Request } from "express";
import { ZodError } from "zod";
import {
  createScheduledJobSchema,
  updateScheduledJobSchema,
  type ApiResponse,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { runNowRateLimiter } from "../middleware/scheduler-run-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import { audit } from "../lib/audit/audit-service.js";
import { prisma } from "../lib/prisma.js";
import { getSchedulerBootstrap, SchedulerError } from "../lib/scheduler/index.js";
import { actorCanAccessProject, type SchedulerActor } from "../lib/scheduler/project-access.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actor(req: Request): SchedulerActor {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

function asAppError(err: unknown): unknown {
  if (err instanceof SchedulerError) return new AppError(err.status, err.code, err.message);
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request payload", {
      issues: err.flatten(),
    });
  }
  return err;
}

export function schedulerRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get("/", requirePermission("scheduler.read"), async (req, res, next) => {
    try {
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
      const { scheduler } = getSchedulerBootstrap();
      const a = actor(req);
      const jobs = await scheduler.listJobs({ projectId }, a);
      res.json(ok(jobs));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.get("/handlers", requirePermission("scheduler.read"), (_req, res, next) => {
    try {
      const { registry } = getSchedulerBootstrap();
      res.json(ok(registry.list().map((h) => ({ type: h.type, description: h.description }))));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post("/", requirePermission("scheduler.manage"), async (req, res, next) => {
    try {
      const input = createScheduledJobSchema.parse(req.body);
      // Epic #164 — autopilot opt-in via payload.autopilot=true on
      // rerun-analysis jobs requires the project to have autopilotEnabled.
      if (
        input.taskType === "rerun-analysis" &&
        input.projectId &&
        isAutopilotPayload(input.payload)
      ) {
        const project = await prisma.project.findUnique({
          where: { id: input.projectId },
          select: { autopilotEnabled: true },
        });
        if (!project?.autopilotEnabled) {
          throw new AppError(
            400,
            "AUTOPILOT_DISABLED",
            "Project must have autopilotEnabled=true before scheduling autopilot analyses",
          );
        }
      }
      const { scheduler } = getSchedulerBootstrap();
      const a = actor(req);
      const row = await scheduler.createJob({ ...input, createdById: a.id }, a);
      res.status(201).json(ok(row));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.get("/:id", requirePermission("scheduler.read"), async (req, res, next) => {
    try {
      const { scheduler } = getSchedulerBootstrap();
      const a = actor(req);
      const row = await scheduler.getJob(String(req.params.id), a);
      if (!row) throw new AppError(404, "JOB_NOT_FOUND", "scheduled job not found");
      res.json(ok(row));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.patch("/:id", requirePermission("scheduler.manage"), async (req, res, next) => {
    try {
      const input = updateScheduledJobSchema.parse(req.body);
      const { scheduler } = getSchedulerBootstrap();
      const a = actor(req);
      const row = await scheduler.updateJob(String(req.params.id), input, a);
      res.json(ok(row));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.delete("/:id", requirePermission("scheduler.manage"), async (req, res, next) => {
    try {
      const { scheduler } = getSchedulerBootstrap();
      const a = actor(req);
      await scheduler.deleteJob(String(req.params.id), a);
      res.status(204).end();
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post(
    "/:id/run",
    requirePermission("scheduler.manage"),
    runNowRateLimiter,
    async (req, res, next) => {
      try {
        const { scheduler } = getSchedulerBootstrap();
        const a = actor(req);
        const task = await scheduler.runNow(String(req.params.id), a);
        res.status(202).json(ok({ taskId: task.id, status: task.status }));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  r.post("/:id/pause", requirePermission("scheduler.manage"), async (req, res, next) => {
    try {
      const { scheduler } = getSchedulerBootstrap();
      const a = actor(req);
      const row = await scheduler.updateJob(String(req.params.id), { enabled: false }, a);
      res.json(ok(row));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.post("/:id/resume", requirePermission("scheduler.manage"), async (req, res, next) => {
    try {
      const { scheduler } = getSchedulerBootstrap();
      const a = actor(req);
      const row = await scheduler.updateJob(String(req.params.id), { enabled: true }, a);
      res.json(ok(row));
    } catch (err) {
      next(asAppError(err));
    }
  });

  r.get("/:id/history", requirePermission("scheduler.read"), async (req, res, next) => {
    try {
      const { scheduler } = getSchedulerBootstrap();
      const a = actor(req);
      const job = await scheduler.getJob(String(req.params.id), a);
      if (!job) {
        // Audit denied probes (L2) — getJob returns null both when the row is
        // missing AND when the actor isn't authorised, so we audit either
        // way. The actorCanAccessProject helper records its own audit when
        // the project membership check fails.
        const exists = await prisma.scheduledJob.findUnique({
          where: { id: String(req.params.id) },
        });
        if (exists) {
          await actorCanAccessProject(a, exists.projectId, {
            resource: "scheduled-job",
            resourceId: String(req.params.id),
            action: "scheduled-job.history",
          });
        } else {
          audit({
            actor: { id: a.id },
            action: "scheduled-job.history.denied",
            target: { type: "scheduled-job", id: String(req.params.id) },
            metadata: { reason: "not-found" },
          });
        }
        throw new AppError(404, "JOB_NOT_FOUND", "scheduled job not found");
      }
      const tasks = await prisma.task.findMany({
        where: { scheduledJobId: String(req.params.id) },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      res.json(ok(tasks));
    } catch (err) {
      next(asAppError(err));
    }
  });

  return r;
}

/**
 * Epic #164 — payload may opt into autopilot mode via `{ autopilot: true }`.
 * The shared zod schema only enforces the wrapping `record(z.unknown())`
 * shape so we duck-type here.
 */
function isAutopilotPayload(payload: Record<string, unknown> | undefined | null): boolean {
  if (!payload || typeof payload !== "object") return false;
  return payload.autopilot === true;
}
