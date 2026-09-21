/**
 * Requirement-link REST surface — Epic #610 (#624).
 *
 * Routes (mounted in `routes/index.ts` + `routes/requirements.ts`):
 *   POST   /api/requirements/:requirementId/links   { targetRequirementId, type }
 *   GET    /api/requirements/:requirementId/links    — incoming + outgoing, with context
 *   DELETE /api/requirement-links/:linkId
 *   GET    /api/workspaces/:workspaceId/requirements/search?q=&excludeProject=&page=&pageSize=
 *
 * All authorization (coarse permission via `requirePermission`, plus the
 * dual-project / workspace-scoping checks) is enforced here + in
 * `requirement-link-service.ts`. Reads require `project.read`; mutations require
 * `project.update` — the same coarse keys the requirements collaboration router
 * uses. The service applies the per-endpoint project access checks.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { REQUIREMENT_LINK_TYPES } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import type { SchedulerActor } from "../lib/scheduler/project-access.js";
import {
  createRequirementLink,
  deleteRequirementLink,
  listRequirementLinks,
  searchWorkspaceRequirements,
} from "../lib/requirements/requirement-link-service.js";

// Express 5 widened ParamsDictionary; route params are always single strings.
type Req = Request & { params: Record<string, string> };

function actor(req: Request): SchedulerActor {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

const createLinkSchema = z.object({
  targetRequirementId: z.string().min(1),
  type: z.enum(REQUIREMENT_LINK_TYPES),
});

const searchSchema = z.object({
  q: z.string().max(200).optional(),
  excludeProject: z.string().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * Nested router for `/api/requirements/:requirementId/links` (mergeParams so the
 * parent `:requirementId` is visible). Handles create + list.
 */
export function requirementLinksRouter(): Router {
  const r = Router({ mergeParams: true });

  // POST /api/requirements/:requirementId/links
  r.post("/", requireAuth, requirePermission("project.update"), async (req: Req, res: Response) => {
    const parsed = createLinkSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid link payload", {
        issues: parsed.error.flatten(),
      });
    }
    const link = await createRequirementLink(prisma, actor(req), {
      sourceRequirementId: String(req.params.requirementId),
      targetRequirementId: parsed.data.targetRequirementId,
      type: parsed.data.type,
    });
    res.status(201).json({ success: true, data: link });
  });

  // GET /api/requirements/:requirementId/links
  r.get("/", requireAuth, requirePermission("project.read"), async (req: Req, res: Response) => {
    const result = await listRequirementLinks(prisma, actor(req), String(req.params.requirementId));
    res.json({ success: true, data: result });
  });

  return r;
}

/**
 * Top-level router for `/api/requirement-links`. Handles delete by link id.
 */
export function requirementLinksResourceRouter(): Router {
  const r = Router();

  // DELETE /api/requirement-links/:linkId
  r.delete(
    "/:linkId",
    requireAuth,
    requirePermission("project.update"),
    async (req: Req, res: Response) => {
      await deleteRequirementLink(prisma, actor(req), String(req.params.linkId));
      res.json({ success: true, data: { removed: true } });
    },
  );

  return r;
}

/**
 * Router for `/api/workspaces/:workspaceId/requirements` (mergeParams). Hosts
 * the workspace-scoped requirement search used by the link picker.
 */
export function workspaceRequirementSearchRouter(): Router {
  const r = Router({ mergeParams: true });

  // GET /api/workspaces/:workspaceId/requirements/search
  r.get(
    "/search",
    requireAuth,
    requirePermission("project.read"),
    async (req: Req, res: Response) => {
      const parsed = searchSchema.safeParse(req.query);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid search query", {
          issues: parsed.error.flatten(),
        });
      }
      const result = await searchWorkspaceRequirements(
        actor(req),
        {
          workspaceId: String(req.params.workspaceId),
          query: parsed.data.q,
          excludeProjectId: parsed.data.excludeProject,
          page: parsed.data.page,
          pageSize: parsed.data.pageSize,
        },
        prisma,
      );
      res.json({ success: true, data: result });
    },
  );

  return r;
}
