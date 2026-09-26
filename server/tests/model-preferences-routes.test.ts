/**
 * /api/projects/:projectId/model-preferences HTTP route tests
 * (Issue #125, Epic #119).
 *
 * Exercises the GET + PUT model-preference handlers over HTTP: success paths,
 * validation/error paths, auth, and not-found. Prisma is mocked in-memory.
 *
 * Provider guardrail (Epic #119): these tests assert the persisted preference
 * values only — they never alter Bedrock / local-gemma runtime routing.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MockProject {
  id: string;
  deletedAt: Date | null;
}

interface MockPref {
  projectId: string;
  defaultModel: string | null;
  taskTypeOverrides: string;
  budgetDowngradeThreshold: number | null;
}

const projects = new Map<string, MockProject>();
const prefs = new Map<string, MockPref>();

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
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => {
        const p = projects.get(where.id);
        return p && !p.deletedAt ? p : null;
      }),
    },
    modelPreference: {
      findUnique: vi.fn(
        async ({ where }: { where: { projectId: string } }) => prefs.get(where.projectId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { projectId: string };
          create: MockPref;
          update: Partial<MockPref>;
        }) => {
          const existing = prefs.get(where.projectId);
          const next: MockPref = existing ? { ...existing, ...update } : { ...create };
          prefs.set(where.projectId, next);
          return next;
        },
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let token: string;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(async () => {
  projects.clear();
  prefs.clear();
  projects.set("proj_1", { id: "proj_1", deletedAt: null });
  app = createApp();
  token = await login();
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/projects/:projectId/model-preferences", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).get("/api/projects/proj_1/model-preferences");
    expect(res.status).toBe(401);
  });

  it("returns 404 for a missing project", async () => {
    const res = await request(app)
      .get("/api/projects/ghost/model-preferences")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("returns defaults when no preference is stored", async () => {
    const res = await request(app)
      .get("/api/projects/proj_1/model-preferences")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.defaultModel).toBeNull();
    expect(res.body.data.taskTypeOverrides).toEqual({});
    expect(res.body.data.availableModels.length).toBeGreaterThan(0);
  });

  it("describes the available models from the model catalog (#135)", async () => {
    const res = await request(app)
      .get("/api/projects/proj_1/model-preferences")
      .set("Authorization", `Bearer ${token}`);
    const sonnet = res.body.data.availableModels.find(
      (m: { id: string }) => m.id === "us.anthropic.claude-sonnet-5",
    );
    expect(sonnet).toMatchObject({
      name: "Claude Sonnet 5",
      tier: "balanced",
      contextWindow: 1_000_000,
      price: { inputPerMTok: 2.2, outputPerMTok: 11 },
      capabilities: { tools: true },
    });
  });

  it("returns the stored preference", async () => {
    prefs.set("proj_1", {
      projectId: "proj_1",
      defaultModel: "us.anthropic.claude-sonnet-4-6",
      taskTypeOverrides: JSON.stringify({ code_review: "us.anthropic.claude-sonnet-4-6" }),
      budgetDowngradeThreshold: 500_000,
    });
    const res = await request(app)
      .get("/api/projects/proj_1/model-preferences")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.defaultModel).toBe("us.anthropic.claude-sonnet-4-6");
    expect(res.body.data.taskTypeOverrides).toEqual({
      code_review: "us.anthropic.claude-sonnet-4-6",
    });
    expect(res.body.data.budgetDowngradeThreshold).toBe(500_000);
  });
});

describe("PUT /api/projects/:projectId/model-preferences", () => {
  it("returns 404 for a missing project", async () => {
    const res = await request(app)
      .put("/api/projects/ghost/model-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultModel: "auto" });
    expect(res.status).toBe(404);
  });

  it("rejects an invalid default model with 400", async () => {
    const res = await request(app)
      .put("/api/projects/proj_1/model-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultModel: "gpt-4-turbo" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("upserts preferences and echoes them back", async () => {
    const res = await request(app)
      .put("/api/projects/proj_1/model-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({
        defaultModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        taskTypeOverrides: { document_analysis: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
        budgetDowngradeThreshold: 250_000,
      });
    expect(res.status).toBe(200);
    expect(res.body.data.defaultModel).toBe("us.anthropic.claude-haiku-4-5-20251001-v1:0");
    expect(res.body.data.taskTypeOverrides).toEqual({
      document_analysis: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(res.body.data.budgetDowngradeThreshold).toBe(250_000);
    expect(prefs.get("proj_1")).toBeDefined();
  });

  it("accepts a null default model (clears the override)", async () => {
    const res = await request(app)
      .put("/api/projects/proj_1/model-preferences")
      .set("Authorization", `Bearer ${token}`)
      .send({ defaultModel: null });
    expect(res.status).toBe(200);
    expect(res.body.data.defaultModel).toBeNull();
  });
});
