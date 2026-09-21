/**
 * `requireRunProjectAccess` — tenant-isolation middleware for `/api/runs/:id*`.
 *
 * Loads the `AgentRun` referenced by `req.params.id`, verifies the caller can
 * read its parent project, and either calls `next()` or rejects with a
 * structured error:
 *
 *   - 404 RUN_NOT_FOUND     — run does not exist
 *   - 401 AUTH_REQUIRED     — `req.user` not populated (paranoid guard;
 *     `requireAuth` should already have rejected)
 *   - 403 FORBIDDEN         — run exists but caller is not in its project
 *
 * Admins always pass; non-admins must be in the run's project access set as
 * defined by `listAccessibleProjectIds`. Runs with `projectId === null`
 * (system runs) are admin-only — same rule as the scheduler routes (#H2/#H3).
 *
 * Resolves the run once and stashes it on `res.locals.run` so handlers can
 * reuse it without a second DB hit.
 */
import type { RequestHandler } from "express";
import { AppError } from "./error-handler.js";
import {
  isAdminActor,
  listAccessibleProjectIds,
  type SchedulerActor,
} from "../lib/scheduler/project-access.js";
import { getRun } from "../lib/replay/runs-service.js";

export const requireRunProjectAccess: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) {
      throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    }
    const id = String(req.params.id ?? "");
    if (!id) {
      throw new AppError(404, "RUN_NOT_FOUND", "Run not found");
    }
    const run = await getRun(id);
    if (!run) {
      throw new AppError(404, "RUN_NOT_FOUND", "Run not found");
    }
    const actor: SchedulerActor = { id: req.user.userId, role: req.user.role };
    if (isAdminActor(actor)) {
      res.locals.run = run;
      next();
      return;
    }
    const projectId = run.run.projectId;
    if (projectId == null) {
      // System run — admin-only.
      throw new AppError(403, "FORBIDDEN", "Insufficient project access for this run");
    }
    const allowed = await listAccessibleProjectIds(actor);
    if (!allowed.includes(projectId)) {
      throw new AppError(403, "FORBIDDEN", "Insufficient project access for this run");
    }
    res.locals.run = run;
    next();
  } catch (err) {
    next(err);
  }
};
