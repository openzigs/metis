/**
 * Template service tests — Epic #595 / Issue #615.
 *
 * Mocks Prisma to test CRUD operations, seeding, and validation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface TemplateRow {
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

const templates = new Map<string, TemplateRow>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    issueTemplate: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string; isDefault?: boolean } }) => {
        return [...templates.values()].filter(
          (t) =>
            t.projectId === where.projectId &&
            (where.isDefault === undefined || t.isDefault === where.isDefault),
        );
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: { id?: string; projectId?: string; platform?: string; templateType?: string };
        }) => {
          for (const t of templates.values()) {
            if (where.id && t.id !== where.id) continue;
            if (where.projectId && t.projectId !== where.projectId) continue;
            if (where.platform && t.platform !== where.platform) continue;
            if (where.templateType && t.templateType !== where.templateType) continue;
            return t;
          }
          return null;
        },
      ),
      count: vi.fn(async ({ where }: { where: { projectId: string; isDefault?: boolean } }) => {
        return [...templates.values()].filter(
          (t) =>
            t.projectId === where.projectId &&
            (where.isDefault === undefined || t.isDefault === where.isDefault),
        ).length;
      }),
      create: vi.fn(async ({ data }: { data: Partial<TemplateRow> }) => {
        nextId++;
        const row: TemplateRow = {
          id: `tpl_${nextId}`,
          projectId: "proj_1",
          name: "",
          platform: "universal",
          templateType: "feature",
          schema: "{}",
          defaultValues: "{}",
          isDefault: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(data as TemplateRow),
        };
        templates.set(row.id, row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<TemplateRow> }) => {
          const existing = templates.get(where.id);
          if (!existing) throw new Error("not found");
          const updated = { ...existing, ...data, updatedAt: new Date() };
          templates.set(where.id, updated);
          return updated;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        templates.delete(where.id);
      }),
    },
  },
}));

import {
  listTemplates,
  getTemplate,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  seedDefaultTemplates,
  findTemplate,
  TemplateServiceError,
} from "../src/lib/publishing/template-service.js";
import { GITHUB_FEATURE_TEMPLATE } from "../src/lib/publishing/default-templates.js";

beforeEach(() => {
  templates.clear();
  nextId = 0;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("listTemplates", () => {
  it("returns all templates for a project", async () => {
    templates.set("tpl_a", {
      id: "tpl_a",
      projectId: "proj_1",
      name: "Template A",
      platform: "github",
      templateType: "feature",
      schema: "{}",
      defaultValues: "{}",
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await listTemplates("proj_1");
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Template A");
  });

  it("returns empty array for project with no templates", async () => {
    const result = await listTemplates("proj_empty");
    expect(result).toHaveLength(0);
  });
});

describe("getTemplate", () => {
  it("returns a template by id and project", async () => {
    templates.set("tpl_1", {
      id: "tpl_1",
      projectId: "proj_1",
      name: "My Template",
      platform: "github",
      templateType: "epic",
      schema: "{}",
      defaultValues: "{}",
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await getTemplate("proj_1", "tpl_1");
    expect(result.name).toBe("My Template");
  });

  it("throws 404 when template not found", async () => {
    await expect(getTemplate("proj_1", "nonexistent")).rejects.toThrow(TemplateServiceError);
    await expect(getTemplate("proj_1", "nonexistent")).rejects.toMatchObject({
      status: 404,
      code: "TEMPLATE_NOT_FOUND",
    });
  });
});

describe("createTemplate", () => {
  it("creates a template with valid schema", async () => {
    const result = await createTemplate("proj_1", {
      name: "Custom Template",
      platform: "github",
      templateType: "feature",
      schema: GITHUB_FEATURE_TEMPLATE,
    });
    expect(result.name).toBe("Custom Template");
    expect(result.isDefault).toBe(false);
    expect(templates.size).toBe(1);
  });

  it("rejects template with invalid schema", async () => {
    await expect(
      createTemplate("proj_1", {
        name: "Bad Template",
        platform: "github",
        templateType: "feature",
        schema: { name: "", platform: "bad", templateType: "what", sections: [] } as never,
      }),
    ).rejects.toThrow(TemplateServiceError);
  });

  it("stores defaultValues when provided", async () => {
    const result = await createTemplate("proj_1", {
      name: "With Defaults",
      platform: "github",
      templateType: "feature",
      schema: GITHUB_FEATURE_TEMPLATE,
      defaultValues: { storyPoints: 5 },
    });
    expect(JSON.parse(result.defaultValues)).toEqual({ storyPoints: 5 });
  });
});

describe("updateTemplate", () => {
  it("updates template name", async () => {
    templates.set("tpl_u1", {
      id: "tpl_u1",
      projectId: "proj_1",
      name: "Original",
      platform: "github",
      templateType: "feature",
      schema: JSON.stringify(GITHUB_FEATURE_TEMPLATE),
      defaultValues: "{}",
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await updateTemplate("proj_1", "tpl_u1", { name: "Updated" });
    expect(result.name).toBe("Updated");
  });

  it("throws 404 when template not found", async () => {
    await expect(updateTemplate("proj_1", "nope", { name: "X" })).rejects.toThrow(
      TemplateServiceError,
    );
  });

  it("validates schema on update", async () => {
    templates.set("tpl_u2", {
      id: "tpl_u2",
      projectId: "proj_1",
      name: "Existing",
      platform: "github",
      templateType: "feature",
      schema: JSON.stringify(GITHUB_FEATURE_TEMPLATE),
      defaultValues: "{}",
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(
      updateTemplate("proj_1", "tpl_u2", {
        schema: { name: "", platform: "bad", templateType: "x", sections: [] } as never,
      }),
    ).rejects.toThrow(TemplateServiceError);
  });
});

describe("deleteTemplate", () => {
  it("deletes a non-default template", async () => {
    templates.set("tpl_d1", {
      id: "tpl_d1",
      projectId: "proj_1",
      name: "Deletable",
      platform: "github",
      templateType: "feature",
      schema: "{}",
      defaultValues: "{}",
      isDefault: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await deleteTemplate("proj_1", "tpl_d1");
    expect(templates.has("tpl_d1")).toBe(false);
  });

  it("rejects deletion of default template", async () => {
    templates.set("tpl_d2", {
      id: "tpl_d2",
      projectId: "proj_1",
      name: "Default",
      platform: "github",
      templateType: "feature",
      schema: "{}",
      defaultValues: "{}",
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await expect(deleteTemplate("proj_1", "tpl_d2")).rejects.toThrow(TemplateServiceError);
    await expect(deleteTemplate("proj_1", "tpl_d2")).rejects.toMatchObject({
      code: "CANNOT_DELETE_DEFAULT",
    });
  });

  it("throws 404 when template not found", async () => {
    await expect(deleteTemplate("proj_1", "nope")).rejects.toThrow(TemplateServiceError);
  });
});

describe("seedDefaultTemplates", () => {
  it("seeds 4 default templates for a new project", async () => {
    const count = await seedDefaultTemplates("proj_new");
    expect(count).toBe(4);
    expect(templates.size).toBe(4);
    const rows = [...templates.values()];
    expect(rows.every((t) => t.isDefault)).toBe(true);
    expect(rows.every((t) => t.projectId === "proj_new")).toBe(true);
  });

  it("is idempotent — skips if defaults already exist", async () => {
    templates.set("tpl_existing", {
      id: "tpl_existing",
      projectId: "proj_existing",
      name: "Default",
      platform: "github",
      templateType: "feature",
      schema: "{}",
      defaultValues: "{}",
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const count = await seedDefaultTemplates("proj_existing");
    expect(count).toBe(0);
    expect(templates.size).toBe(1); // no new templates added
  });

  it("seeded templates have correct names and platforms", async () => {
    await seedDefaultTemplates("proj_check");
    const rows = [...templates.values()].filter((t) => t.projectId === "proj_check");
    const names = rows.map((t) => t.name);
    expect(names).toContain("GitHub Epic");
    expect(names).toContain("GitHub Feature");
    expect(names).toContain("Jira Story");
    expect(names).toContain("Jira Bug");
  });
});

describe("findTemplate", () => {
  it("finds template by platform and type", async () => {
    templates.set("tpl_f1", {
      id: "tpl_f1",
      projectId: "proj_1",
      name: "GitHub Feature",
      platform: "github",
      templateType: "feature",
      schema: JSON.stringify(GITHUB_FEATURE_TEMPLATE),
      defaultValues: "{}",
      isDefault: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const result = await findTemplate("proj_1", "github", "feature");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("GitHub Feature");
  });

  it("returns null when no matching template", async () => {
    const result = await findTemplate("proj_empty", "github", "feature");
    expect(result).toBeNull();
  });
});
