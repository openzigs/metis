/**
 * Epic #165 (#113) — Project-scoped skill-directories + disabled-skills.
 *
 * RBAC (issue #1075, epic #1051). Until #1075 every route here gated on
 * `requireAuth` alone, so a `reader` — read-only by design in
 * `packages/shared/src/rbac.ts` — could rewrite project configuration. The
 * tiers below are deliberately not uniform:
 *
 *   • reads → `project.read`, the permission every role including `reader`
 *     carries; these endpoints only echo configuration back.
 *   • `disabled-skills` writes → `project.update`, matching the sibling
 *     per-project skill allow-list in `library.ts:93` (`PUT/DELETE
 *     /projects/:projectId/library/skills/:skillId`), which is the same
 *     decision — "is this skill available to this project" — expressed on the
 *     other model. `coordinator` and `admin` keep it; no role that could
 *     legitimately do this before loses it.
 *   • `skill-directories` writes → `skill.manage` (admin-only), the permission
 *     that already governs what skill content the platform loads
 *     (`skills.ts:123+`). This route writes a SERVER filesystem path that the
 *     scanner later reads, so it is an operator action, not a project one.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import {
  SkillDirectoryError,
  scan,
  validateDirectoryEntry,
} from "../lib/library/skill-directories.js";
import { audit } from "../lib/audit/audit-service.js";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function rethrow(err: unknown): never {
  if (err instanceof SkillDirectoryError) {
    throw new AppError(400, "SKILL_DIRECTORY", err.message);
  }
  throw err;
}

function parseList(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

const directorySchema = z.object({ path: z.string().min(1).max(2_000) });
const slugSchema = z.object({ slug: z.string().min(1).max(120) });

export function skillDirectoriesRouter(): Router {
  const r = Router({ mergeParams: true });

  // Skill directories — list / add / remove
  r.get(
    "/skill-directories",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { skillDirectories: true, disabledSkills: true },
      });
      if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");
      const directories = parseList(project.skillDirectories);
      const disabled = parseList(project.disabledSkills);
      const result = await scan(directories, disabled);
      res.json(
        ok({
          directories,
          disabled,
          discovered: result.skills.map((s) => ({
            slug: s.slug,
            excerpt: s.excerpt,
            directorySource: s.directorySource,
          })),
          errors: result.errors,
        }),
      );
    },
  );

  r.post(
    "/skill-directories",
    requireAuth,
    requirePermission("skill.manage"),
    async (req: Request, res: Response) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const parsed = directorySchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      let resolved: string;
      try {
        resolved = validateDirectoryEntry(parsed.data.path);
      } catch (err) {
        rethrow(err);
      }
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { skillDirectories: true },
      });
      if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");
      const list = parseList(project.skillDirectories);
      if (!list.includes(resolved)) list.push(resolved);
      await prisma.project.update({
        where: { id: projectId },
        data: { skillDirectories: JSON.stringify(list) },
      });
      audit({
        actor: { id: actorId(req) },
        action: "project.skill_directory.added",
        target: { type: "project", id: projectId },
        metadata: { path: resolved },
      });
      res.status(201).json(ok({ directories: list }));
    },
  );

  r.delete(
    "/skill-directories",
    requireAuth,
    requirePermission("skill.manage"),
    async (req: Request, res: Response) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const parsed = directorySchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { skillDirectories: true },
      });
      if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");
      const list = parseList(project.skillDirectories).filter((p) => p !== parsed.data.path);
      await prisma.project.update({
        where: { id: projectId },
        data: { skillDirectories: JSON.stringify(list) },
      });
      audit({
        actor: { id: actorId(req) },
        action: "project.skill_directory.removed",
        target: { type: "project", id: projectId },
        metadata: { path: parsed.data.path },
      });
      res.json(ok({ directories: list }));
    },
  );

  // Disabled skills — list / add / remove
  r.get(
    "/disabled-skills",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { disabledSkills: true },
      });
      if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");
      res.json(ok({ disabled: parseList(project.disabledSkills) }));
    },
  );

  r.post(
    "/disabled-skills",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const parsed = slugSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { disabledSkills: true },
      });
      if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");
      const list = parseList(project.disabledSkills);
      if (!list.includes(parsed.data.slug)) list.push(parsed.data.slug);
      await prisma.project.update({
        where: { id: projectId },
        data: { disabledSkills: JSON.stringify(list) },
      });
      audit({
        actor: { id: actorId(req) },
        action: "project.skill_disabled",
        target: { type: "project", id: projectId },
        metadata: { slug: parsed.data.slug },
      });
      res.status(201).json(ok({ disabled: list }));
    },
  );

  r.delete(
    "/disabled-skills",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const parsed = slugSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { disabledSkills: true },
      });
      if (!project) throw new AppError(404, "NOT_FOUND", "Project not found");
      const list = parseList(project.disabledSkills).filter((s) => s !== parsed.data.slug);
      await prisma.project.update({
        where: { id: projectId },
        data: { disabledSkills: JSON.stringify(list) },
      });
      audit({
        actor: { id: actorId(req) },
        action: "project.skill_enabled",
        target: { type: "project", id: projectId },
        metadata: { slug: parsed.data.slug },
      });
      res.json(ok({ disabled: list }));
    },
  );

  return r;
}
