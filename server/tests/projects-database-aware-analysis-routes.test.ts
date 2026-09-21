/**
 * Integration tests for the `databaseAwareAnalysis` project-settings API
 * (Epic #852 Phase 3 / issue #857): the raw setting read/write plus the
 * resolved decision (`enabled`/`ran`/`reason`/`hasSchemaData`).
 *
 * Mocks Prisma in-memory + audit, drives the routes via supertest, and
 * exercises validation (400), object-level authz (404 for a workspace
 * non-member — mirrors the #674 `requireProjectAccess` chokepoint tests), and
 * the resolver's `on`/`off`/`auto`-with-data/`auto`-without-data outcomes.
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
  databaseAwareAnalysis: string;
  deletedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

const projects = new Map<string, MockProject>();
const auditCalls: Array<{ action: string; metadata?: Record<string, unknown> }> = [];

/** Toggled per-test to drive the `hasSchemaData` probe (#854). */
let connectedDbCount = 0;
let schemaSymbolCount = 0;
let schemaEdgeCount = 0;

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
    databaseConnection: {
      count: vi.fn(async () => connectedDbCount),
    },
    codeSymbol: {
      count: vi.fn(async () => schemaSymbolCount),
    },
    codeEdge: {
      count: vi.fn(async () => schemaEdgeCount),
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
  const id = overrides.id ?? "proj_dba_1";
  const row: MockProject = {
    id,
    name: "DB-Aware Demo",
    slug: "dba-demo",
    description: "",
    status: "active",
    createdById: "user_admin",
    workspaceId: null,
    databaseAwareAnalysis: "auto",
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  projects.set(id, row);
  return row;
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
});

beforeEach(() => {
  projects.clear();
  auditCalls.length = 0;
  connectedDbCount = 0;
  schemaSymbolCount = 0;
  schemaEdgeCount = 0;
  __resetArchiveHooks();
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/:id/database-aware-analysis", () => {
  it("returns the raw setting alongside the resolved decision", async () => {
    seedProject({ databaseAwareAnalysis: "on" });
    connectedDbCount = 1;
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      setting: "on",
      enabled: true,
      ran: true,
      reason: "on",
      hasSchemaData: true,
    });
  });

  it("resolves auto->resolved-off-no-data when auto has no schema data", async () => {
    seedProject({ databaseAwareAnalysis: "auto" });
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      setting: "auto",
      enabled: false,
      ran: false,
      reason: "auto->resolved-off-no-data",
      hasSchemaData: false,
    });
  });

  it("resolves auto->resolved-on when the schema graph is non-empty", async () => {
    seedProject({ databaseAwareAnalysis: "auto" });
    schemaSymbolCount = 3;
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      setting: "auto",
      enabled: true,
      ran: true,
      reason: "auto->resolved-on",
      hasSchemaData: true,
    });
  });

  it("resolves off unconditionally, even with schema data present", async () => {
    seedProject({ databaseAwareAnalysis: "off" });
    connectedDbCount = 1;
    schemaEdgeCount = 5;
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      setting: "off",
      enabled: false,
      ran: false,
      reason: "off",
      hasSchemaData: true,
    });
  });

  it("returns 404 for an unknown project", async () => {
    const token = await loginAs("admin");
    const res = await request(app)
      .get("/api/projects/nope/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/projects/:id/database-aware-analysis", () => {
  it("updates the setting, persists it, and audit-logs the change", async () => {
    seedProject({ databaseAwareAnalysis: "auto" });
    const token = await loginAs("admin");
    const res = await request(app)
      .patch("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseAwareAnalysis: "on" });
    expect(res.status).toBe(200);
    expect(res.body.data.databaseAwareAnalysis).toBe("on");
    expect(projects.get("proj_dba_1")?.databaseAwareAnalysis).toBe("on");
    expect(auditCalls.map((c) => c.action)).toContain("project.databaseAwareAnalysis.update");
    const entry = auditCalls.find((c) => c.action === "project.databaseAwareAnalysis.update");
    expect(entry?.metadata).toEqual({ previous: "auto", next: "on" });
  });

  it("rejects an unrecognized setting with 400 and does not persist it", async () => {
    seedProject({ databaseAwareAnalysis: "auto" });
    const token = await loginAs("admin");
    const res = await request(app)
      .patch("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseAwareAnalysis: "enabled" });
    expect(res.status).toBe(400);
    expect(projects.get("proj_dba_1")?.databaseAwareAnalysis).toBe("auto");
    expect(auditCalls.map((c) => c.action)).not.toContain("project.databaseAwareAnalysis.update");
  });

  it("rejects a missing body with 400", async () => {
    seedProject();
    const token = await loginAs("admin");
    const res = await request(app)
      .patch("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown project", async () => {
    const token = await loginAs("admin");
    const res = await request(app)
      .patch("/api/projects/nope/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseAwareAnalysis: "off" });
    expect(res.status).toBe(404);
  });

  it("returns 404 (not 403) for a caller who is not a member of the project's workspace", async () => {
    // `coordinator` DOES have `project.update` — proves the object-level
    // #674 workspace-scope chokepoint (`requireProjectAccess`), not the role
    // layer, is what blocks a non-member here (no existence oracle).
    seedProject({ databaseAwareAnalysis: "auto", workspaceId: "ws_other" });
    const token = await loginAs("coordinator");
    const res = await request(app)
      .patch("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseAwareAnalysis: "on" });
    expect(res.status).toBe(404);
    expect(projects.get("proj_dba_1")?.databaseAwareAnalysis).toBe("auto");
    expect(auditCalls.map((c) => c.action)).not.toContain("project.databaseAwareAnalysis.update");
  });

  it("returns 404 (not 403) reading the resolved state for a workspace non-member", async () => {
    seedProject({ databaseAwareAnalysis: "auto", workspaceId: "ws_other" });
    const token = await loginAs("coordinator");
    const res = await request(app)
      .get("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("rejects a reader (no project.update permission) with 403 inside their own workspace", async () => {
    seedProject({ databaseAwareAnalysis: "auto", workspaceId: null });
    const token = await loginAs("reader");
    const res = await request(app)
      .patch("/api/projects/proj_dba_1/database-aware-analysis")
      .set("Authorization", `Bearer ${token}`)
      .send({ databaseAwareAnalysis: "on" });
    expect(res.status).toBe(403);
    expect(projects.get("proj_dba_1")?.databaseAwareAnalysis).toBe("auto");
  });
});
