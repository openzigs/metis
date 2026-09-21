/**
 * /api/projects/:projectId/templates — route layer tests.
 *
 * Mocks Prisma + template service to test auth, RBAC, validation,
 * and error mapping at the route surface.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({ id: `user_${create.username}`, ...create }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    // #674 — the templates router now runs the `requireProjectAccess`
    // chokepoint (assertProjectAccess → project.findUnique). A null workspaceId
    // keeps the project open to any authed caller, preserving these tests' focus
    // on template CRUD + role authz.
    project: { findUnique: vi.fn(async () => ({ workspaceId: null })) },
    issueTemplate: {
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) => {
        return [...templates.values()].filter((t) => t.projectId === where.projectId);
      }),
      findFirst: vi.fn(async ({ where }: { where: { id?: string; projectId?: string } }) => {
        for (const t of templates.values()) {
          if (where.id && t.id !== where.id) continue;
          if (where.projectId && t.projectId !== where.projectId) continue;
          return t;
        }
        return null;
      }),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: { data: Partial<TemplateRow> }) => {
        nextId++;
        const row: TemplateRow = {
          id: `tpl_${nextId}`,
          projectId: "",
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
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function seedTemplate(id: string, overrides: Partial<TemplateRow> = {}): TemplateRow {
  const row: TemplateRow = {
    id,
    projectId: "proj_test_001",
    name: "Test Template",
    platform: "github",
    templateType: "feature",
    schema: JSON.stringify({
      name: "Test",
      platform: "github",
      templateType: "feature",
      sections: [
        { key: "title", label: "Title", type: "text", required: true },
        { key: "desc", label: "Desc", type: "markdown", required: true },
      ],
    }),
    defaultValues: "{}",
    isDefault: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  templates.set(id, row);
  return row;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  templates.clear();
  nextId = 0;
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("auth gate", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(app).get("/api/projects/proj_test_001/templates");
    expect(res.status).toBe(401);
  });
});

describe("GET /templates", () => {
  it("lists templates for a project", async () => {
    seedTemplate("tpl_1");
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_test_001/templates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("reader is rejected with 403", async () => {
    const token = await login("reader");
    const res = await request(app)
      .get("/api/projects/proj_test_001/templates")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});

describe("GET /templates/:id", () => {
  it("returns a specific template", async () => {
    seedTemplate("tpl_get_1");
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_test_001/templates/tpl_get_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("tpl_get_1");
  });

  it("returns 404 for non-existent template", async () => {
    const token = await login("admin");
    const res = await request(app)
      .get("/api/projects/proj_test_001/templates/nope")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("POST /templates", () => {
  it("creates a template with valid payload", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "New Template",
        platform: "github",
        templateType: "feature",
        schema: {
          name: "New",
          platform: "github",
          templateType: "feature",
          sections: [
            { key: "title", label: "Title", type: "text", required: true },
            { key: "desc", label: "Desc", type: "markdown", required: true },
          ],
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe("New Template");
  });

  it("rejects invalid payload (Zod 400)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "" }); // Missing required fields
    expect(res.status).toBe(400);
  });

  it("developer can create templates (issue.draft)", async () => {
    const token = await login("developer");
    const res = await request(app)
      .post("/api/projects/proj_test_001/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Dev Template",
        platform: "github",
        templateType: "feature",
        schema: {
          name: "Dev",
          platform: "github",
          templateType: "feature",
          sections: [{ key: "title", label: "Title", type: "text", required: true }],
        },
      });
    expect(res.status).toBe(201);
  });
});

describe("PUT /templates/:id", () => {
  it("updates a template", async () => {
    seedTemplate("tpl_put_1");
    const token = await login("admin");
    const res = await request(app)
      .put("/api/projects/proj_test_001/templates/tpl_put_1")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Updated Name" });
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Updated Name");
  });

  it("returns 404 for non-existent template", async () => {
    const token = await login("admin");
    const res = await request(app)
      .put("/api/projects/proj_test_001/templates/nope")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "X" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /templates/:id", () => {
  it("deletes a non-default template", async () => {
    seedTemplate("tpl_del_1");
    const token = await login("admin");
    const res = await request(app)
      .delete("/api/projects/proj_test_001/templates/tpl_del_1")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
  });

  it("rejects deletion of default template with 400", async () => {
    seedTemplate("tpl_del_2", { isDefault: true });
    const token = await login("admin");
    const res = await request(app)
      .delete("/api/projects/proj_test_001/templates/tpl_del_2")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent template", async () => {
    const token = await login("admin");
    const res = await request(app)
      .delete("/api/projects/proj_test_001/templates/nope")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("Zod schema enforcement", () => {
  it("rejects sections array exceeding maxSections (50)", async () => {
    const token = await login("admin");
    const sections = Array.from({ length: 51 }, (_, i) => ({
      key: `section_${i}`,
      label: `Section ${i}`,
      type: "text",
      required: false,
    }));
    const res = await request(app)
      .post("/api/projects/proj_test_001/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Bloated Template",
        platform: "github",
        templateType: "feature",
        schema: {
          name: "Bloated",
          platform: "github",
          templateType: "feature",
          sections,
        },
      });
    expect(res.status).toBe(400);
  });

  it("rejects unrecognized validation fields (strict schema)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Bad Validation",
        platform: "github",
        templateType: "feature",
        schema: {
          name: "Bad",
          platform: "github",
          templateType: "feature",
          sections: [
            {
              key: "title",
              label: "Title",
              type: "text",
              required: true,
              validation: { minLength: 1, bogusField: true },
            },
          ],
        },
      });
    expect(res.status).toBe(400);
  });

  it("accepts valid typed validation fields", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_test_001/templates")
      .set("Authorization", `Bearer ${token}`)
      .send({
        name: "Typed Validation",
        platform: "github",
        templateType: "feature",
        schema: {
          name: "Typed",
          platform: "github",
          templateType: "feature",
          sections: [
            {
              key: "title",
              label: "Title",
              type: "text",
              required: true,
              validation: { minLength: 1, maxLength: 200, pattern: "^[A-Za-z]" },
            },
          ],
        },
      });
    expect(res.status).toBe(201);
  });
});
