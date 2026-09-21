/**
 * /api/projects/:projectId/change-analyses — Epic #557 / Issue #565.
 *
 * Endpoints:
 *   POST /                     trigger a change analysis (base vs head)
 *   GET  /                     list change analyses for project
 *   GET  /:id                  get change analysis detail with changes
 *   POST /:id/changes/:changeId/review   approve or reject a change
 */
import { Router, type Request } from "express";
import { ZodError } from "zod";
import { triggerChangeAnalysisSchema, reviewChangeSchema, type ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import {
  triggerChangeAnalysis,
  listChangeAnalyses,
  getChangeAnalysis,
  reviewChange,
  ChangeAnalysisError,
} from "../lib/change-analysis/change-analysis-engine.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

/**
 * The path project every handler scopes its work to.
 *
 * `requireProjectAccess()` (below) has already rejected a missing `:projectId`
 * with a 400 and an unreachable one with a 404, so by the time a handler runs
 * this is a non-empty id the caller is known to be able to reach.
 */
function projectIdOf(req: Request): string {
  return String(req.params.projectId);
}

function asAppError(err: unknown): unknown {
  if (err instanceof ChangeAnalysisError) {
    return new AppError(err.status, err.code, err.message);
  }
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request payload", {
      issues: err.flatten(),
    });
  }
  return err;
}

export function changeAnalysisRouter(): Router {
  const r = Router({ mergeParams: true });
  r.use(requireAuth);
  // Issue #1073 (epic #1051) — object-level scope for the PATH project. Until
  // now this router relied entirely on the `/projects/:id/:sub` catch-all
  // (`projects.ts:94`), i.e. on the mount ORDER of a ~90-layer table. Carrying
  // its own guard makes the scoping below meaningful: `:projectId` is only
  // worth threading into a query once the caller is known to reach it.
  r.use(requireProjectAccess());

  // POST / — trigger change analysis
  r.post("/", requirePermission("analysis.run"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const body = triggerChangeAnalysisSchema.parse(req.body);
      const result = await triggerChangeAnalysis({
        projectId,
        baseAnalysisId: body.baseAnalysisId,
        headAnalysisId: body.headAnalysisId,
        actorId: actor(req),
      });
      res.status(201).json(ok(result));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // GET / — list change analyses for project
  r.get("/", requirePermission("analysis.read"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const rows = await listChangeAnalyses(projectId);
      res.json(ok(rows));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // GET /:id — get detail with changes
  r.get("/:id", requirePermission("analysis.read"), async (req, res, next) => {
    try {
      const detail = await getChangeAnalysis({
        id: String(req.params.id),
        projectId: projectIdOf(req),
      });
      res.json(ok(detail));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // POST /:id/changes/:changeId/review — approve or reject
  r.post(
    "/:id/changes/:changeId/review",
    requirePermission("analysis.run"),
    async (req, res, next) => {
      try {
        const body = reviewChangeSchema.parse(req.body);
        const updated = await reviewChange({
          projectId: projectIdOf(req),
          changeAnalysisId: String(req.params.id),
          changeId: String(req.params.changeId),
          reviewStatus: body.reviewStatus,
          actorId: actor(req),
        });
        res.json(ok(updated));
      } catch (err) {
        next(asAppError(err));
      }
    },
  );

  return r;
}
