/**
 * Template Service — Epic #595 / Issue #611.
 *
 * CRUD operations for IssueTemplate, plus seeding default templates
 * when a new project is created.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { validateTemplateSchema } from "./template-validator.js";
import { DEFAULT_TEMPLATES } from "./default-templates.js";
import type { TemplateSchema } from "./template-schema.js";

const log = createChildLogger("template-service");

export class TemplateServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "TemplateServiceError";
  }
}

export interface TemplateRow {
  id: string;
  projectId: string;
  name: string;
  platform: string;
  templateType: string;
  schema: string;
  defaultValues: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTemplateInput {
  name: string;
  platform: string;
  templateType: string;
  schema: TemplateSchema;
  defaultValues?: Record<string, unknown>;
}

export interface UpdateTemplateInput {
  name?: string;
  platform?: string;
  templateType?: string;
  schema?: TemplateSchema;
  defaultValues?: Record<string, unknown>;
}

/**
 * List all templates for a project.
 */
export async function listTemplates(projectId: string): Promise<TemplateRow[]> {
  return prisma.issueTemplate.findMany({
    where: { projectId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
  });
}

/**
 * Get a single template by ID, scoped to a project.
 */
export async function getTemplate(projectId: string, templateId: string): Promise<TemplateRow> {
  const row = await prisma.issueTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!row) {
    throw new TemplateServiceError(404, "TEMPLATE_NOT_FOUND", "template not found");
  }
  return row;
}

/**
 * Create a new template for a project.
 */
export async function createTemplate(
  projectId: string,
  input: CreateTemplateInput,
): Promise<TemplateRow> {
  const validation = validateTemplateSchema(input.schema);
  if (!validation.valid) {
    throw new TemplateServiceError(
      400,
      "INVALID_TEMPLATE_SCHEMA",
      `invalid template schema: ${validation.errors.join("; ")}`,
    );
  }

  return prisma.issueTemplate.create({
    data: {
      projectId,
      name: input.name,
      platform: input.platform,
      templateType: input.templateType,
      schema: JSON.stringify(input.schema),
      defaultValues: JSON.stringify(input.defaultValues ?? {}),
      isDefault: false,
    },
  });
}

/**
 * Update an existing template. Default templates can be updated but not deleted.
 */
export async function updateTemplate(
  projectId: string,
  templateId: string,
  input: UpdateTemplateInput,
): Promise<TemplateRow> {
  const existing = await prisma.issueTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!existing) {
    throw new TemplateServiceError(404, "TEMPLATE_NOT_FOUND", "template not found");
  }

  if (input.schema) {
    const validation = validateTemplateSchema(input.schema);
    if (!validation.valid) {
      throw new TemplateServiceError(
        400,
        "INVALID_TEMPLATE_SCHEMA",
        `invalid template schema: ${validation.errors.join("; ")}`,
      );
    }
  }

  return prisma.issueTemplate.update({
    where: { id: templateId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.platform !== undefined && { platform: input.platform }),
      ...(input.templateType !== undefined && { templateType: input.templateType }),
      ...(input.schema !== undefined && { schema: JSON.stringify(input.schema) }),
      ...(input.defaultValues !== undefined && {
        defaultValues: JSON.stringify(input.defaultValues),
      }),
    },
  });
}

/**
 * Delete a template. Default templates cannot be deleted.
 */
export async function deleteTemplate(projectId: string, templateId: string): Promise<void> {
  const existing = await prisma.issueTemplate.findFirst({
    where: { id: templateId, projectId },
  });
  if (!existing) {
    throw new TemplateServiceError(404, "TEMPLATE_NOT_FOUND", "template not found");
  }
  if (existing.isDefault) {
    throw new TemplateServiceError(
      400,
      "CANNOT_DELETE_DEFAULT",
      "default templates cannot be deleted; clone it instead",
    );
  }
  await prisma.issueTemplate.delete({ where: { id: templateId } });
}

/**
 * Seed default templates for a project. Called when a new project is created.
 * Idempotent — skips if the project already has default templates.
 */
export async function seedDefaultTemplates(projectId: string): Promise<number> {
  const existing = await prisma.issueTemplate.count({
    where: { projectId, isDefault: true },
  });
  if (existing > 0) {
    log.debug("project already has default templates, skipping seed", { projectId });
    return 0;
  }

  let seeded = 0;
  for (const tpl of DEFAULT_TEMPLATES) {
    await prisma.issueTemplate.create({
      data: {
        projectId,
        name: tpl.name,
        platform: tpl.platform,
        templateType: tpl.templateType,
        schema: JSON.stringify(tpl),
        defaultValues: JSON.stringify(
          Object.fromEntries(
            tpl.sections
              .filter((s) => s.defaultValue !== undefined)
              .map((s) => [s.key, s.defaultValue]),
          ),
        ),
        isDefault: true,
      },
    });
    seeded++;
  }

  log.info("seeded default templates", { projectId, count: seeded });
  return seeded;
}

/**
 * Find a template matching the given platform and type for a project.
 * Used by the draft generator to load the appropriate template.
 */
export async function findTemplate(
  projectId: string,
  platform: string,
  templateType: string,
): Promise<TemplateRow | null> {
  // Prefer exact match, then universal fallback
  const exact = await prisma.issueTemplate.findFirst({
    where: { projectId, platform, templateType },
    orderBy: { isDefault: "asc" }, // custom templates first
  });
  if (exact) return exact;

  return prisma.issueTemplate.findFirst({
    where: { projectId, platform: "universal", templateType },
    orderBy: { isDefault: "asc" },
  });
}
