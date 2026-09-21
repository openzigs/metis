/**
 * /api/projects/:projectId/templates — Epic #595 / Issue #611.
 *
 * CRUD endpoints for issue templates.
 *
 *   GET    /                 list templates
 *   GET    /:id              get template
 *   POST   /                 create template
 *   PUT    /:id              update template
 *   DELETE /:id              delete template (non-default only)
 */
import { Router, type Request } from "express";
import { z, ZodError } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  seedDefaultTemplates,
  TemplateServiceError,
} from "../lib/publishing/template-service.js";
import type { ApiResponse } from "@metis/shared";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function projectIdOf(req: Request): string {
  const id = String(req.params.projectId ?? "");
  if (!id) throw new AppError(400, "INVALID_PROJECT", "projectId required");
  return id;
}

function asAppError(err: unknown): unknown {
  if (err instanceof TemplateServiceError) {
    return new AppError(err.status, err.code, err.message);
  }
  if (err instanceof ZodError) {
    return new AppError(400, "VALIDATION_ERROR", "Invalid request payload", {
      issues: err.flatten(),
    });
  }
  return err;
}

const sectionValidationSchema = z
  .object({
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().nonnegative().optional(),
    minItems: z.number().int().nonnegative().optional(),
    maxItems: z.number().int().nonnegative().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    pattern: z.string().optional(),
    options: z.array(z.string()).optional(),
  })
  .strict();

const sectionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  type: z.enum(["text", "markdown", "checklist", "number", "select", "tags"]),
  required: z.boolean(),
  validation: sectionValidationSchema.optional(),
  defaultValue: z.unknown().optional(),
  placeholder: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(128),
  platform: z.enum(["github", "jira", "universal"]),
  templateType: z.enum(["epic", "feature", "story", "bug", "task"]),
  schema: z.object({
    name: z.string().min(1),
    platform: z.enum(["github", "jira", "universal"]),
    templateType: z.enum(["epic", "feature", "story", "bug", "task"]),
    sections: z.array(sectionSchema).min(1).max(50),
    platformFields: z.record(z.record(z.string())).optional(),
  }),
  defaultValues: z.record(z.unknown()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  platform: z.enum(["github", "jira", "universal"]).optional(),
  templateType: z.enum(["epic", "feature", "story", "bug", "task"]).optional(),
  schema: z
    .object({
      name: z.string().min(1),
      platform: z.enum(["github", "jira", "universal"]),
      templateType: z.enum(["epic", "feature", "story", "bug", "task"]),
      sections: z.array(sectionSchema).min(1).max(50),
      platformFields: z.record(z.record(z.string())).optional(),
    })
    .optional(),
  defaultValues: z.record(z.unknown()).optional(),
});

export function templatesRouter(): Router {
  const r = Router({ mergeParams: true });
  r.use(requireAuth);
  // Epic #671 / #674 — object-level project scope (OWASP A01 / BOLA). Templates
  // are addressed by PK under `/projects/:projectId/templates`; the by-id
  // PUT/DELETE previously had no project binding. Gate the whole subtree on the
  // caller's workspace membership before any handler runs (non-members → 404).
  r.use(requireProjectAccess());

  // List all templates for a project (lazy-seeds defaults for pre-existing projects)
  r.get("/", requirePermission("issue.draft"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      let templates = await listTemplates(projectId);
      if (templates.length === 0) {
        await seedDefaultTemplates(projectId);
        templates = await listTemplates(projectId);
      }
      res.json(ok(templates));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // Get a single template
  r.get("/:id", requirePermission("issue.draft"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const template = await getTemplate(projectId, String(req.params.id));
      res.json(ok(template));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // Create a new template
  r.post("/", requirePermission("issue.draft"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const body = createSchema.parse(req.body);
      const template = await createTemplate(projectId, body);
      res.status(201).json(ok(template));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // Update a template
  r.put("/:id", requirePermission("issue.draft"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      const body = updateSchema.parse(req.body);
      const template = await updateTemplate(projectId, String(req.params.id), body);
      res.json(ok(template));
    } catch (err) {
      next(asAppError(err));
    }
  });

  // Delete a template
  r.delete("/:id", requirePermission("issue.draft"), async (req, res, next) => {
    try {
      const projectId = projectIdOf(req);
      await deleteTemplate(projectId, String(req.params.id));
      res.json(ok({ deleted: true }));
    } catch (err) {
      next(asAppError(err));
    }
  });

  return r;
}
