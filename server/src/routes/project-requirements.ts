/**
 * Issue #2347 — `GET /api/projects/:projectId/requirements`: the project's
 * requirements across every change request, paged and filtered on the server
 * (the Requirements tab). Query: `analysisId` (one change request), `status`
 * (`draft` | `approved` | `rejected` | `deferred`), `q` (title search),
 * `page` (from 1), `pageSize` (1-100).
 *
 * Read-only: approve, edit and request review from the list call the same
 * guarded endpoints as the analysis page (`PUT /api/requirements/:id`,
 * `POST /api/projects/:projectId/reviews`).
 *
 * Access (OWASP A01): a per-IP limiter, then `requireAuth`, then
 * `requireProjectAccess()` (the caller may open the project) and
 * `analysis.read`; the service filters every query on the project.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import { projectRequirementsPreAuthRateLimiter } from "../middleware/project-requirements-rate-limit.js";
import {
  PROJECT_REQUIREMENTS_PAGE_SIZE_MAX,
  REQUIREMENT_LIST_STATUSES,
  listProjectRequirements,
} from "../lib/requirements/project-requirements-list.js";

const querySchema = z.object({
  analysisId: z.string().trim().min(1).max(64).optional(),
  status: z.enum(REQUIREMENT_LIST_STATUSES).optional(),
  q: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(PROJECT_REQUIREMENTS_PAGE_SIZE_MAX).default(25),
});

export function projectRequirementsRouter(): Router {
  const r = Router({ mergeParams: true });
  r.get(
    "/",
    projectRequirementsPreAuthRateLimiter,
    requireAuth,
    requireProjectAccess(),
    requirePermission("analysis.read"),
    async (req: Request, res: Response) => {
      const parsed = querySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid requirements query", {
          issues: parsed.error.flatten(),
        });
      }
      const data = await listProjectRequirements(String(req.params.projectId), parsed.data);
      res.json({ success: true, data });
    },
  );
  return r;
}
