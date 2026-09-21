/**
 * /api/skills \u2014 Phase 10 Skill library routes.
 *
 * Global CRUD requires `skill.manage`. Per-project allow-list endpoints live
 * under `/api/projects/:projectId/skills/...` (see project-library.ts) and
 * additionally require `project.update`.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { audit } from "../lib/audit/audit-service.js";
import {
  getSkillService,
  SkillServiceError,
  getSessionRuntime,
  SessionRuntimeError,
  searchLibrary,
  LibraryImporter,
  InlineLoader,
} from "../lib/library/index.js";
import { FrontmatterError } from "../lib/library/frontmatter.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

function rethrow(err: unknown): never {
  if (err instanceof SkillServiceError) {
    throw new AppError(err.status, err.code, err.message);
  }
  if (err instanceof SessionRuntimeError) {
    throw new AppError(err.status, err.code, err.message);
  }
  // Frontmatter parse/validation failures stem from the submitted source —
  // user-fixable input, so surface them as 4xx rather than a 500.
  if (err instanceof FrontmatterError) {
    throw new AppError(400, err.code, err.message);
  }
  throw err;
}

const upsertSchema = z.object({
  source: z.string().min(3).max(500_000),
  key: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/i)
    .optional(),
  origin: z.string().max(200).optional(),
});

const importInlineSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(500),
        contents: z.string().min(3).max(500_000),
      }),
    )
    .min(1)
    .max(50),
});

export function skillsRouter(): Router {
  const r = Router();

  r.get("/", requireAuth, async (req: Request, res: Response) => {
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const includeArchived = req.query.includeArchived === "1";
    const items = await getSkillService().list({ tag, query, includeArchived });
    res.json(ok({ items }));
  });

  r.get("/search", requireAuth, async (req: Request, res: Response) => {
    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const tag = typeof req.query.tag === "string" ? req.query.tag : undefined;
    const items = await searchLibrary({ query, tag, kinds: ["skill"] });
    res.json(ok({ items }));
  });

  r.get("/:id", requireAuth, async (req: Request, res: Response) => {
    const item = await getSkillService().get(String(req.params.id));
    if (!item) throw new AppError(404, "SKILL_NOT_FOUND", "Skill not found");
    res.json(ok(item));
  });

  r.get("/:id/versions", requireAuth, async (req: Request, res: Response) => {
    const items = await getSkillService().listVersions(String(req.params.id));
    res.json(ok({ items }));
  });

  r.get("/:id/versions/:versionId", requireAuth, async (req: Request, res: Response) => {
    const item = await getSkillService().getVersion(
      String(req.params.id),
      String(req.params.versionId),
    );
    if (!item) throw new AppError(404, "SKILL_VERSION_NOT_FOUND", "Skill version not found");
    res.json(ok(item));
  });

  r.get("/:id/diff", requireAuth, async (req: Request, res: Response) => {
    const left = typeof req.query.left === "string" ? req.query.left : null;
    const right = typeof req.query.right === "string" ? req.query.right : null;
    if (!left || !right) {
      throw new AppError(400, "VALIDATION_ERROR", "left + right query params required");
    }
    const items = await getSkillService().diff(String(req.params.id), left, right);
    res.json(ok(items));
  });

  r.post(
    "/",
    requireAuth,
    requirePermission("skill.manage"),
    async (req: Request, res: Response) => {
      const parsed = upsertSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid skill payload", {
          issues: parsed.error.flatten(),
        });
      }
      try {
        const created = await getSkillService().create(parsed.data, actorFromReq(req));
        res.status(201).json(ok(created));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.patch("/:id", requireAuth, requirePermission("skill.manage"), async (req, res) => {
    const parsed = upsertSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid skill payload", {
        issues: parsed.error.flatten(),
      });
    }
    try {
      const updated = await getSkillService().update(
        String(req.params.id),
        parsed.data,
        actorFromReq(req),
      );
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/:id/archive", requireAuth, requirePermission("skill.manage"), async (req, res) => {
    try {
      const updated = await getSkillService().archive(String(req.params.id), actorFromReq(req));
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/:id/enable", requireAuth, requirePermission("skill.manage"), async (req, res) => {
    try {
      const updated = await getSkillService().setEnabled(
        String(req.params.id),
        true,
        actorFromReq(req),
      );
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/:id/disable", requireAuth, requirePermission("skill.manage"), async (req, res) => {
    try {
      const updated = await getSkillService().setEnabled(
        String(req.params.id),
        false,
        actorFromReq(req),
      );
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.delete("/:id", requireAuth, requirePermission("skill.manage"), async (req, res) => {
    try {
      await getSkillService().remove(String(req.params.id), actorFromReq(req));
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });

  // Bulk import \u2014 inline (paste / multi-file upload). Repo + filesystem
  // sources are wired in routes/library.ts.
  r.post(
    "/import/inline",
    requireAuth,
    requirePermission("skill.manage"),
    async (req: Request, res: Response) => {
      const parsed = importInlineSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid import payload", {
          issues: parsed.error.flatten(),
        });
      }
      const importer = new LibraryImporter();
      const loader = new InlineLoader(parsed.data.files);
      const result = await importer.importSkills(loader, actorFromReq(req));
      res.status(201).json(ok(result));
    },
  );

  // ── Session runtime: load-skill into chat session ────────────────────
  // Enforcement: SessionRuntime.loadSkillIntoSession consults the target
  // session's project allow-list (ProjectSkillAllowlist). Skills not on the
  // allow-list of a project-bound session are rejected with a 403
  // PROJECT_SKILL_NOT_ALLOWED before any prompt mutation. Ad-hoc sessions
  // with no projectId fall back to the global enabled-skill set.
  r.post("/:id/load", requireAuth, async (req: Request, res: Response) => {
    const sessionId = z.object({ sessionId: z.string().min(1) }).safeParse(req.body ?? {});
    if (!sessionId.success) {
      throw new AppError(400, "VALIDATION_ERROR", "sessionId required");
    }
    try {
      const result = await getSessionRuntime().loadSkillIntoSession(
        { sessionId: sessionId.data.sessionId, skillId: String(req.params.id) },
        actorFromReq(req),
      );
      audit({
        actor: { id: req.user!.userId },
        action: "skill.load.api",
        target: { type: "ai_session", id: sessionId.data.sessionId },
        metadata: { skillId: req.params.id, alreadyLoaded: result.alreadyLoaded },
      });
      res.json(ok(result));
    } catch (err) {
      rethrow(err);
    }
  });

  return r;
}
