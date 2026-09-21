/**
 * Epic #609 / Issue #620 — requirement-baseline REST surface.
 *
 * Routes:
 *   GET  /api/projects/:projectId/baselines        — list           (review.read)
 *   POST /api/projects/:projectId/baselines        — manual create  (review.admin)
 *   GET  /api/baselines/:baselineId                — contents: each requirement
 *                                                    AS OF its pinned version (review.read)
 *   GET  /api/baselines/:idA/compare/:idB          — added/removed/changed(field-level)/
 *                                                    unchanged sets (review.read)
 *
 * Baselines are IMMUTABLE: there is deliberately no update or delete route,
 * and compare is read-only. The only write path is the admin-gated manual
 * create (auto-creation on review approval lives in review-service.ts, #617).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  compareBaselines,
  createManualBaseline,
  getBaselineContents,
  listBaselines,
} from "../lib/reviews/baseline-service.js";

// ---- Schemas ----------------------------------------------------------------

/**
 * Only whitelisted fields are read from the body — `createdById`,
 * `reviewRequestId`, and per-item `version` pins are server-controlled
 * (no mass assignment; manual baselines always pin CURRENT versions).
 */
const createBaselineSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(4000).optional(),
  requirementIds: z.array(z.string().min(1)).min(1).max(500).optional(),
});

// ---- Helpers ----------------------------------------------------------------

function parsePositiveInt(value: unknown, fallback: number): number {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ---- Routers ----------------------------------------------------------------

/** Mounted at `/api/projects/:projectId/baselines`. */
export function projectBaselinesRouter(): Router {
  const r = Router({ mergeParams: true });

  // GET / — project-scoped baseline list (newest first).
  r.get("/", requireAuth, requirePermission("review.read"), async (req: Request, res: Response) => {
    const page = parsePositiveInt(req.query.page, 1);
    const pageSize = Math.min(
      parsePositiveInt(req.query.pageSize, DEFAULT_PAGE_SIZE),
      MAX_PAGE_SIZE,
    );
    const data = await listBaselines(String(req.params.projectId), page, pageSize);
    res.json({ success: true, data });
  });

  // POST / — manual baseline pinning CURRENT requirement versions (admin only).
  r.post(
    "/",
    requireAuth,
    requirePermission("review.admin"),
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const parsed = createBaselineSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid baseline payload", {
          issues: parsed.error.flatten(),
        });
      }
      const baseline = await createManualBaseline(
        req.user.userId,
        String(req.params.projectId),
        parsed.data,
      );
      res.status(201).json({ success: true, data: baseline });
    },
  );

  return r;
}

/** Mounted at `/api/baselines`. */
export function baselinesRouter(): Router {
  const r = Router();

  // GET /:idA/compare/:idB — added / removed / changed / unchanged (read-only).
  r.get(
    "/:idA/compare/:idB",
    requireAuth,
    requirePermission("review.read"),
    async (req: Request, res: Response) => {
      const data = await compareBaselines(String(req.params.idA), String(req.params.idB));
      res.json({ success: true, data });
    },
  );

  // GET /:baselineId — contents: every pin rendered AS OF its pinned version.
  r.get(
    "/:baselineId",
    requireAuth,
    requirePermission("review.read"),
    async (req: Request, res: Response) => {
      const data = await getBaselineContents(String(req.params.baselineId));
      res.json({ success: true, data });
    },
  );

  return r;
}
