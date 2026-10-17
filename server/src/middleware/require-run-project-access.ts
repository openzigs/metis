/**
 * `requireRunProjectAccess` — tenant-isolation middleware for `/api/runs/:id*`.
 *
 * Loads the `AgentRun` referenced by `req.params.id`, verifies the caller can
 * read its parent project, and either calls `next()` or rejects with a
 * structured error:
 *
 *   - 404 RUN_NOT_FOUND     — run does not exist, OR it exists but the
 *     caller cannot reach its project. #340 — the two answer the SAME body
 *     (it used to be 403 FORBIDDEN for the latter), so a probe cannot tell a
 *     foreign run id from an unknown one.
 *   - 401 AUTH_REQUIRED     — `req.user` not populated (paranoid guard;
 *     `requireAuth` should already have rejected)
 *
 * Admins always pass; anyone else must pass the project-access rule on the
 * run's project (`actorHasProjectAccess` → `assertProjectAccess`: the live
 * members of the project's workspace, legacy workspace-less projects, never a
 * soft-deleted project). #1232 — it used to admit only the project's creator,
 * while `GET /api/runs` already listed the run to every member. Runs with
 * `projectId === null` (system runs) are admin-only — same rule as the
 * scheduler routes (#H2/#H3). Every route behind this is a read
 * (`analysis.read`).
 *
 * Resolves the run once and stashes it on `res.locals.run` so handlers can
 * reuse it without a second DB hit.
 */
import type { RequestHandler } from "express";
import { AppError } from "./error-handler.js";
import {
  actorHasProjectAccess,
  isAdminActor,
  type SchedulerActor,
} from "../lib/scheduler/project-access.js";
import { getRun } from "../lib/replay/runs-service.js";

const runNotFound = () => new AppError(404, "RUN_NOT_FOUND", "Run not found");

export const requireRunProjectAccess: RequestHandler = async (req, res, next) => {
  try {
    if (!req.user) {
      throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    }
    const id = String(req.params.id ?? "");
    if (!id) {
      throw runNotFound();
    }
    const run = await getRun(id);
    if (!run) {
      throw runNotFound();
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
      throw runNotFound();
    }
    const allowed = await actorHasProjectAccess(actor, projectId, {
      resource: "agent_run",
      resourceId: id,
      action: "run.read",
    });
    if (!allowed) {
      throw runNotFound();
    }
    res.locals.run = run;
    next();
  } catch (err) {
    next(err);
  }
};
