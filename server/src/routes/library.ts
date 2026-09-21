/**
 * /api/library \u2014 combined Skill + Agent search and per-project allow-list
 * management (Phase 10).
 *
 * Search is read-only and available to any authenticated user. The per-project
 * allow-list routes are mounted at /api/projects/:projectId/library and are
 * gated in two layers: `requireProjectAccess()` at the router level (object
 * scope — may the caller reach this project at all, #1074) and
 * `requirePermission("project.update")` per mutation (role).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { getProjectLibraryAllowlist, AllowlistError, searchLibrary } from "../lib/library/index.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId };
}

function rethrow(err: unknown): never {
  if (err instanceof AllowlistError) {
    throw new AppError(err.status, err.code, err.message);
  }
  throw err;
}

const allowlistMutationSchema = z.object({
  enabled: z.boolean(),
});

export function libraryRouter(): Router {
  const r = Router();

  // Combined search (skills + agents).
  r.get("/", requireAuth, async (req: Request, res: Response) => {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const kindParam = typeof req.query.kind === "string" ? req.query.kind : undefined;
    const kinds: Array<"skill" | "agent"> | undefined =
      kindParam === "skill" || kindParam === "agent" ? [kindParam] : undefined;
    const items = await searchLibrary({ query, tag, kinds });
    res.json(ok({ items }));
  });

  return r;
}

/**
 * Mounted at /api/projects/:projectId/library/...
 */
export function projectLibraryRouter(): Router {
  const r = Router({ mergeParams: true });

  // Issue #1074 (epic #671 / #674) — object-level project scope (OWASP A01 /
  // BOLA). Every route below is addressed under `/projects/:projectId/library`
  // and reads or mutates that project's skill/agent allow-list, so gate the
  // whole subtree on the caller's membership of the target project's workspace
  // BEFORE any handler runs. Non-members get a 404 (no existence oracle);
  // system admins bypass; pre-migration null-workspace projects stay open.
  //
  // This MUST be the first layer in the router. Until #1074 the subtree was
  // protected only by the `/projects/:id/:sub` catch-all on `projectsRouter()`
  // (`projects.ts:94`), which happens to be mounted first in `index.ts` — i.e.
  // the router's safety was a property of a 90+ entry mount table declared in
  // another file, not of the router. Reference pattern: `connectors.ts:269`.
  r.use(requireAuth, requireProjectAccess());

  /**
   * Resolve the target project for a mutation, rejecting soft-deleted ones.
   *
   * NOTE: this is deliberately NOT an authorization check — that is the
   * router-level `requireProjectAccess()` above. It was previously named
   * `ensureProjectAccess`, a name that promised a membership check its `where`
   * clause never performed (#1074). What it does carry, and what the access
   * guard does not, is the `deletedAt: null` filter: `assertProjectAccess`
   * resolves a project without consulting soft-delete state.
   */
  async function ensureProjectExists(
    req: Request,
  ): Promise<{ projectId: string; actorId: string }> {
    const projectId = String(req.params.projectId);
    const project = await prisma.project.findFirst({
      where: { id: projectId, deletedAt: null },
    });
    if (!project) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found");
    return { projectId, actorId: actorFromReq(req).id };
  }

  r.get("/skills", requireAuth, async (req, res) => {
    const projectId = String(req.params.projectId);
    const items = await getProjectLibraryAllowlist().listSkills(projectId);
    res.json(ok({ items }));
  });

  // Effective skills available to this project's chat sessions — mirrors the
  // runtime gate (default-allow all enabled skills when no explicit rows). The
  // chat skills picker uses this so authored, globally-enabled skills are
  // actually loadable, instead of the empty explicit-allowlist view (#468).
  r.get("/skills/available", requireAuth, async (req, res) => {
    const projectId = String(req.params.projectId);
    const items = await getProjectLibraryAllowlist().resolveAvailableSkills(projectId);
    res.json(ok({ items }));
  });

  r.get("/agents", requireAuth, async (req, res) => {
    const projectId = String(req.params.projectId);
    const items = await getProjectLibraryAllowlist().listAgents(projectId);
    res.json(ok({ items }));
  });

  r.put("/skills/:skillId", requireAuth, requirePermission("project.update"), async (req, res) => {
    const parsed = allowlistMutationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "enabled flag required");
    }
    const ctx = await ensureProjectExists(req);
    try {
      await getProjectLibraryAllowlist().setSkillEnabled(
        ctx.projectId,
        String(req.params.skillId),
        parsed.data.enabled,
        { id: ctx.actorId },
      );
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });

  r.delete(
    "/skills/:skillId",
    requireAuth,
    requirePermission("project.update"),
    async (req, res) => {
      const ctx = await ensureProjectExists(req);
      try {
        await getProjectLibraryAllowlist().removeSkill(ctx.projectId, String(req.params.skillId), {
          id: ctx.actorId,
        });
        res.status(204).end();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.put("/agents/:agentId", requireAuth, requirePermission("project.update"), async (req, res) => {
    const parsed = allowlistMutationSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "enabled flag required");
    }
    const ctx = await ensureProjectExists(req);
    try {
      await getProjectLibraryAllowlist().setAgentEnabled(
        ctx.projectId,
        String(req.params.agentId),
        parsed.data.enabled,
        { id: ctx.actorId },
      );
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });

  r.delete(
    "/agents/:agentId",
    requireAuth,
    requirePermission("project.update"),
    async (req, res) => {
      const ctx = await ensureProjectExists(req);
      try {
        await getProjectLibraryAllowlist().removeAgent(ctx.projectId, String(req.params.agentId), {
          id: ctx.actorId,
        });
        res.status(204).end();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  return r;
}
