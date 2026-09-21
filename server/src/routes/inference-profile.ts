/**
 * Epic #594 / Issue #604 — Inference Profile API routes.
 *
 * Endpoints:
 *   GET  /api/projects/:projectId/inference-profile
 *   PUT  /api/projects/:projectId/inference-profile
 */
import { Router, type Request, type Response } from "express";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  getInferenceProfileManager,
  inferenceProfileSchema,
} from "../lib/ai/inference-profile-manager.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

export function inferenceProfileRouter(): Router {
  const r = Router({ mergeParams: true });
  const mgr = getInferenceProfileManager();

  r.get(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const profile = await mgr.get(projectId);
      res.json(ok({ profile }));
    },
  );

  r.put(
    "/",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = String(req.params.projectId);
      const parsed = inferenceProfileSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          parsed.error.issues[0]?.message ?? "Invalid input",
        );
      }
      const profile = await mgr.upsert(projectId, parsed.data);
      res.json(ok({ profile }));
    },
  );

  return r;
}
