/**
 * Issue #535 — `/api/search/federated` REST endpoint.
 *
 * Provides a direct REST interface for cross-project federated search,
 * independent of the AI tool system. Used by the UI scope selector.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import {
  getFederatedSearchService,
  type FederatedSearchResult,
} from "../lib/rag/federated-search-service.js";
import { getUserAccessibleProjects } from "../lib/auth/accessible-projects.js";

const federatedSearchBodySchema = z.object({
  query: z.string().min(1).max(2048),
  projectIds: z.array(z.string().min(1).max(120)).max(50).optional(),
  k: z.number().int().min(1).max(50).optional(),
});

export function searchRouter(): Router {
  const r = Router();

  /**
   * POST /api/search/federated
   * Body: { query, projectIds?, k? }
   * Returns federated search results across user's accessible projects.
   */
  r.post("/federated", requireAuth, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");

    const parsed = federatedSearchBodySchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "INVALID_INPUT", parsed.error.message);
    }

    const { query, projectIds, k } = parsed.data;
    const service = getFederatedSearchService();
    const result = await service.searchAcrossProjects({
      userId,
      projectIds,
      query,
      k,
    });

    const response: ApiResponse<FederatedSearchResult> = { success: true, data: result };
    res.json(response);
  });

  /**
   * GET /api/search/projects
   * Returns the list of projects accessible to the authenticated user.
   * Used by the UI scope selector to populate the project picker.
   */
  r.get("/projects", requireAuth, async (req: Request, res: Response) => {
    const userId = req.user?.userId;
    if (!userId) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");

    const projects = await getUserAccessibleProjects(userId);
    const response: ApiResponse<typeof projects> = { success: true, data: projects };
    res.json(response);
  });

  return r;
}
