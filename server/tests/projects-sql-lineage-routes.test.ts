/**
 * Integration tests for the `sqlLineage` project-settings API (Epic #882
 * Phase 3 / issue #894): the raw setting read/write plus the resolved
 * decision (`enabled`/`reason`/`sidecarConfigured`).
 *
 * Mirrors `projects-database-aware-analysis-routes.test.ts` (#857): mocks
 * Prisma in-memory + audit, drives the routes via supertest, and exercises
 * validation (400), object-level authz (404 for a workspace non-member), and
 * the resolver's `on`/`off`/`auto` outcomes against the platform default.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MockProject {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  createdById: string;
  workspaceId: string | null;
  sqlLineage: string;
  deletedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

const projects = new Map<string, MockProject>();
const auditCalls: Array<{ action: string; metadata?: Record<string, unknown> }> = [];

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "user_admin",
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: { where: { id?: string; slug?: string } }) => {
        if (where.id) return projects.get(where.id) ?? null;
        if (where.slug) {
          for (const p of projects.values()) if (p.slug === where.slug) return p;
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const p = projects.get(where.id);
        return p && !p.deletedAt ? p : null;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<MockProject> }) => {
          const cur = projects.get(where.id);
          if (!cur) throw new Error("not found");
          const next: MockProject = { ...cur, ...data, updatedAt: new Date() };
          projects.set(where.id, next);
          return next;
        },
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: { action: string; metadata?: Record<string, unknown> }) => {
    auditCalls.push(entry);
  }),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { __resetArchiveHooks } from "../src/lib/projects/project-service.js";

let app: ReturnType<typeof createApp>;

async function loginAs(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function seedProject(overrides: Partial<MockProject> = {}): MockProject {
  const id = overrides.id ?? "proj_sql_1";
  const row: MockProject = {
    id,
    name: "SQL-Lineage Demo",
    slug: "sql-lineage-demo",
    description: "",
    status: "active",
    createdById: "user_admin",
    workspaceId: null,
    sqlLineage: "auto",
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  projects.set(id, row);
  return row;
}

const ORIGINAL_MODE = process.env.SQL_LINEAGE_MODE;
const ORIGINAL_TOKEN = process.env.SQL_LINEAGE_TOKEN;

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
});

beforeEach(() => {
  projects.clear();
  auditCalls.length = 0;
  __resetArchiveHooks();
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
  if (ORIGINAL_MODE === undefined) delete process.env.SQL_LINEAGE_MODE;
  else process.env.SQL_LINEAGE_MODE = ORIGINAL_MODE;
  if (ORIGINAL_TOKEN === undefined) delete process.env.SQL_LINEAGE_TOKEN;
  else process.env.SQL_LINEAGE_TOKEN = ORIGINAL_TOKEN;
});

describe("GET /api/projects/:id/sql-lineage", () => {
  it("returns the raw setting alongside the resolved decision (on, sidecar configured)", async () => {
    seedProject({ sqlLineage: "on" });
    process.env.SQL_LINEAGE_TOKEN = "shhh";
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      setting: "on",
      enabled: true,
      reason: "on",
      sidecarConfigured: true,
    });
  });

  it("surfaces sidecarConfigured=false when enabled but the token is unset (no silent no-op)", async () => {
    seedProject({ sqlLineage: "on" });
    delete process.env.SQL_LINEAGE_TOKEN;
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      setting: "on",
      enabled: true,
      reason: "on",
      sidecarConfigured: false,
    });
  });

  it("resolves auto->platform-disabled when auto and the platform default is off", async () => {
    seedProject({ sqlLineage: "auto" });
    process.env.SQL_LINEAGE_MODE = "in-process";
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      setting: "auto",
      enabled: false,
      reason: "auto->platform-disabled",
    });
  });

  it("resolves auto->platform-enabled when auto and the platform default is sidecar", async () => {
    seedProject({ sqlLineage: "auto" });
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      setting: "auto",
      enabled: true,
      reason: "auto->platform-enabled",
    });
  });

  it("resolves off unconditionally, even when the platform default is sidecar", async () => {
    seedProject({ sqlLineage: "off" });
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ setting: "off", enabled: false, reason: "off" });
  });

  it("returns 404 for an unknown project", async () => {
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/nope/sql-lineage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/projects/:id/sql-lineage", () => {
  it("updates the setting, persists it, and audit-logs the change", async () => {
    seedProject({ sqlLineage: "auto" });
    const token = await loginAs("admin");
    const res = await request(app)
      .patch("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`)
      .send({ sqlLineage: "on" });
    expect(res.status).toBe(200);
    expect(res.body.data.sqlLineage).toBe("on");
    expect(projects.get("proj_sql_1")?.sqlLineage).toBe("on");
    expect(auditCalls.map((c) => c.action)).toContain("project.sqlLineage.update");
    const entry = auditCalls.find((c) => c.action === "project.sqlLineage.update");
    expect(entry?.metadata).toEqual({ previous: "auto", next: "on" });
  });

  it("rejects an unrecognized setting with 400 and does not persist it", async () => {
    seedProject({ sqlLineage: "auto" });
    const token = await loginAs("admin");
    const res = await request(app)
      .patch("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`)
      .send({ sqlLineage: "enabled" });
    expect(res.status).toBe(400);
    expect(projects.get("proj_sql_1")?.sqlLineage).toBe("auto");
    expect(auditCalls.map((c) => c.action)).not.toContain("project.sqlLineage.update");
  });

  it("rejects a missing body with 400", async () => {
    seedProject();
    const token = await loginAs("admin");
    const res = await request(app)
      .patch("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown project", async () => {
    const token = await loginAs("admin");
    const res = await request(app)
      .patch("/api/projects/nope/sql-lineage")
      .set("Authorization", `Bearer ${token}`)
      .send({ sqlLineage: "off" });
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 403) for a caller who is not a member of the project's workspace", async () => {
    seedProject({ sqlLineage: "auto", workspaceId: "ws_other" });
    const token = await loginAs("coordinator");
    const res = await request(app)
      .patch("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`)
      .send({ sqlLineage: "on" });
    expect(res.status).toBe(404);
    expect(projects.get("proj_sql_1")?.sqlLineage).toBe("auto");
    expect(auditCalls.map((c) => c.action)).not.toContain("project.sqlLineage.update");
  });

  it("returns 404 (not 403) reading the resolved state for a workspace non-member", async () => {
    seedProject({ sqlLineage: "auto", workspaceId: "ws_other" });
    const token = await loginAs("coordinator");
    const res = await request(app)
      .get("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("rejects a reader (no project.update permission) with 403 inside their own workspace", async () => {
    seedProject({ sqlLineage: "auto", workspaceId: null });
    const token = await loginAs("reader");
    const res = await request(app)
      .patch("/api/projects/proj_sql_1/sql-lineage")
      .set("Authorization", `Bearer ${token}`)
      .send({ sqlLineage: "on" });
    expect(res.status).toBe(403);
    expect(projects.get("proj_sql_1")?.sqlLineage).toBe("auto");
  });
});
