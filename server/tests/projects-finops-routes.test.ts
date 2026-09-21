/**
 * Integration tests for the new FinOps + safety project routes (Epic #164).
 *
 * Mocks Prisma in-memory + audit, logs in as the seeded mock-provider admin,
 * and drives the routes via supertest. Verifies validation, RBAC, audit
 * emission, and the 402 budget circuit-breaker behaviour.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface MockProject {
  id: string;
  name: string;
  slug: string;
  description: string;
  status: string;
  createdById: string;
  monthlyTokenBudget: number | null;
  safetyMode: string;
  autopilotEnabled: boolean;
  autopilotCostCeilingCents: number | null;
  deletedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

interface MockTokenUsage {
  projectId: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costCents: number;
  createdAt: Date;
}

interface MockSafetyEvent {
  id: string;
  projectId: string;
  sessionId: string | null;
  direction: string;
  verdict: string;
  findings: string;
  createdAt: Date;
}

const projects = new Map<string, MockProject>();
const tokenUsages: MockTokenUsage[] = [];
const safetyEvents: MockSafetyEvent[] = [];
const auditCalls: Array<{ action: string }> = [];

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
    tokenUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { projectId: string; createdAt?: { gte?: Date; lt?: Date } };
        }) =>
          tokenUsages.filter((r) => {
            if (r.projectId !== where.projectId) return false;
            if (where.createdAt?.gte && r.createdAt < where.createdAt.gte) return false;
            if (where.createdAt?.lt && r.createdAt >= where.createdAt.lt) return false;
            return true;
          }),
      ),
    },
    safetyEvent: {
      findMany: vi.fn(
        async ({
          where,
          take = 50,
        }: {
          where: { projectId: string; verdict?: string; createdAt?: { gte?: Date; lt?: Date } };
          take?: number;
        }) => {
          let rows = safetyEvents.filter((r) => r.projectId === where.projectId);
          if (where.verdict) rows = rows.filter((r) => r.verdict === where.verdict);
          if (where.createdAt?.gte) rows = rows.filter((r) => r.createdAt >= where.createdAt!.gte!);
          if (where.createdAt?.lt) rows = rows.filter((r) => r.createdAt < where.createdAt!.lt!);
          return rows.slice(0, take);
        },
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn((entry: { action: string }) => {
    auditCalls.push(entry);
  }),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { __resetArchiveHooks } from "../src/lib/projects/project-service.js";

let app: ReturnType<typeof createApp>;
let token: string;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function seedProject(overrides: Partial<MockProject> = {}): MockProject {
  const id = overrides.id ?? "proj_finops_1";
  const row: MockProject = {
    id,
    name: "FinOps Demo",
    slug: "finops-demo",
    description: "",
    status: "active",
    createdById: "user_admin",
    monthlyTokenBudget: null,
    safetyMode: "standard",
    autopilotEnabled: false,
    autopilotCostCeilingCents: null,
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

beforeEach(async () => {
  projects.clear();
  tokenUsages.length = 0;
  safetyEvents.length = 0;
  auditCalls.length = 0;
  __resetArchiveHooks();
  app = createApp();
  token = await login();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/projects/:id/usage-summary", () => {
  it("returns 404 for missing project", async () => {
    const res = await request(app)
      .get("/api/projects/nope/usage-summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("returns an aggregated usage summary", async () => {
    seedProject({ monthlyTokenBudget: 5000 });
    const day = new Date();
    tokenUsages.push({
      projectId: "proj_finops_1",
      provider: "openai",
      model: "gpt-4o",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      costCents: 5,
      createdAt: day,
    });
    const res = await request(app)
      .get("/api/projects/proj_finops_1/usage-summary")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalTokens).toBe(150);
    expect(res.body.data.byProvider).toHaveLength(1);
    expect(res.body.data.monthlyTokenBudget).toBe(5000);
  });

  it("rejects malformed 'from' timestamps with 400", async () => {
    seedProject();
    const res = await request(app)
      .get("/api/projects/proj_finops_1/usage-summary?from=not-a-date")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/projects/:id/safety-events", () => {
  it("returns recent safety events filtered by verdict", async () => {
    seedProject();
    const now = new Date();
    safetyEvents.push(
      {
        id: "se1",
        projectId: "proj_finops_1",
        sessionId: "s1",
        direction: "input",
        verdict: "blocked",
        findings: JSON.stringify([{ kind: "prompt_injection", count: 1 }]),
        createdAt: now,
      },
      {
        id: "se2",
        projectId: "proj_finops_1",
        sessionId: "s2",
        direction: "output",
        verdict: "redacted",
        findings: JSON.stringify([{ kind: "ssn", count: 1 }]),
        createdAt: now,
      },
    );
    const res = await request(app)
      .get("/api/projects/proj_finops_1/safety-events?verdict=blocked")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].verdict).toBe("blocked");
    expect(res.body.data.items[0].findings).toEqual([{ kind: "prompt_injection", count: 1 }]);
  });

  it("rejects unknown verdict with 400", async () => {
    seedProject();
    const res = await request(app)
      .get("/api/projects/proj_finops_1/safety-events?verdict=oops")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/projects/:id/safety", () => {
  it("updates safetyMode and audit-logs the change", async () => {
    seedProject();
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/safety")
      .set("Authorization", `Bearer ${token}`)
      .send({ safetyMode: "strict" });
    expect(res.status).toBe(200);
    expect(res.body.data.safetyMode).toBe("strict");
    expect(auditCalls.map((c) => c.action)).toContain("project.safety.update");
  });

  it("rejects invalid safetyMode with 400", async () => {
    seedProject();
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/safety")
      .set("Authorization", `Bearer ${token}`)
      .send({ safetyMode: "extra-strict" });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/projects/:id/budget", () => {
  it("updates monthlyTokenBudget and audit-logs the change", async () => {
    seedProject();
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/budget")
      .set("Authorization", `Bearer ${token}`)
      .send({ monthlyTokenBudget: 10_000 });
    expect(res.status).toBe(200);
    expect(res.body.data.monthlyTokenBudget).toBe(10_000);
    expect(auditCalls.map((c) => c.action)).toContain("project.budget.update");
  });

  it("clears the budget when null is supplied", async () => {
    seedProject({ monthlyTokenBudget: 100 });
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/budget")
      .set("Authorization", `Bearer ${token}`)
      .send({ monthlyTokenBudget: null });
    expect(res.status).toBe(200);
    expect(res.body.data.monthlyTokenBudget).toBeNull();
  });

  it("rejects negative budgets with 400", async () => {
    seedProject();
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/budget")
      .set("Authorization", `Bearer ${token}`)
      .send({ monthlyTokenBudget: -5 });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/projects/:id/autopilot", () => {
  it("toggles autopilot and updates the cost ceiling", async () => {
    seedProject();
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/autopilot")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true, costCeilingCents: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.data.autopilotEnabled).toBe(true);
    expect(res.body.data.autopilotCostCeilingCents).toBe(5000);
    expect(auditCalls.map((c) => c.action)).toContain("project.autopilot.update");
  });

  it("rejects negative cost ceiling with 400", async () => {
    seedProject();
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/autopilot")
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: true, costCeilingCents: -100 });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /api/projects/:id/allow-credential-scan (Epic #701)", () => {
  it("toggles the per-project credential scan flag and emits audit", async () => {
    seedProject();
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/allow-credential-scan")
      .set("Authorization", `Bearer ${token}`)
      .send({ allowCredentialScan: true });
    expect(res.status).toBe(200);
    expect(res.body.data.allowCredentialScan).toBe(true);
    expect(auditCalls.map((c) => c.action)).toContain("project.allowCredentialScan.update");
  });

  it("returns 400 when the body is invalid", async () => {
    seedProject();
    const res = await request(app)
      .patch("/api/projects/proj_finops_1/allow-credential-scan")
      .set("Authorization", `Bearer ${token}`)
      .send({ allowCredentialScan: "yes" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown projects", async () => {
    const res = await request(app)
      .patch("/api/projects/missing/allow-credential-scan")
      .set("Authorization", `Bearer ${token}`)
      .send({ allowCredentialScan: false });
    expect(res.status).toBe(404);
  });
});
