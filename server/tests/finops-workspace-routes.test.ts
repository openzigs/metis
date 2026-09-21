/**
 * Integration tests for the workspace FinOps routes (Epic #47 / Issue #54).
 *
 * Mocks Prisma + audit, logs in as the seeded mock-provider admin (admin
 * bypasses workspace RBAC), and drives the routes via supertest. Verifies
 * routing, validation, budget update, alert-rule CRUD, and — importantly —
 * that the channel list NEVER leaks the signing secret.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const alertRules: Array<Record<string, unknown>> = [];
const alertChannels: Array<Record<string, unknown>> = [];
const workspaceRow = { id: "w1", name: "Acme", monthlyBudgetCents: null as number | null };

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
      findMany: vi.fn(async () => []),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    workspace: {
      findUnique: vi.fn(async () => ({ ...workspaceRow })),
      update: vi.fn(async ({ data }: { data: { monthlyBudgetCents: number | null } }) => {
        workspaceRow.monthlyBudgetCents = data.monthlyBudgetCents;
        return { monthlyBudgetCents: data.monthlyBudgetCents };
      }),
    },
    costForecast: {
      findFirst: vi.fn(async () => ({
        id: "cf1",
        workspaceId: "w1",
        projectId: null,
        scope: "workspace",
        monthToDateCents: 5000,
        projectedMonthEndCents: 9000,
        dailyRunRateCents: 300,
        slopeCentsPerDay: 1.2,
        ewmaCents: 290,
        sampleDays: 15,
        backtestMape: 0.08,
        computedAt: new Date(),
      })),
    },
    alertRule: {
      findMany: vi.fn(async () => alertRules),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          alertRules.find((r) => r.id === where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const rule = { id: `r${alertRules.length + 1}`, ...data };
        alertRules.push(rule);
        return rule;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const r = alertRules.find((x) => x.id === where.id);
          Object.assign(r as object, data);
          return r;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const idx = alertRules.findIndex((x) => x.id === where.id);
        if (idx >= 0) alertRules.splice(idx, 1);
        return {};
      }),
    },
    alertChannel: {
      findMany: vi.fn(async ({ select }: { select?: Record<string, boolean> }) =>
        alertChannels.map((c) => {
          if (!select) return c;
          const projected: Record<string, unknown> = {};
          for (const k of Object.keys(select)) projected[k] = c[k];
          return projected;
        }),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const channel = { id: `c${alertChannels.length + 1}`, ...data };
        alertChannels.push(channel);
        return channel;
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          alertChannels.find((c) => c.id === where.id) ?? null,
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const idx = alertChannels.findIndex((c) => c.id === where.id);
        if (idx >= 0) alertChannels.splice(idx, 1);
        return {};
      }),
    },
    alertEvent: {
      findMany: vi.fn(async () => [
        {
          id: "ae1",
          workspaceId: "w1",
          ruleId: "r1",
          spendCents: 9000,
          budgetCents: 10000,
          ratio: 0.9,
          basis: "projected",
          deliveries: "[]",
          firedAt: new Date(),
        },
      ]),
    },
    project: { findMany: vi.fn(async () => []) },
    aITokenUsage: { findMany: vi.fn(async () => []) },
  });
  return { prisma };
});

vi.mock("../src/lib/docs-gen/exporters.js", () => ({
  exportDocument: vi.fn(async (_md: string, title: string) => ({
    buffer: Buffer.from("%PDF-1.4 fake"),
    mimeType: "application/pdf",
    filename: `${title}.pdf`,
  })),
}));

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
});

beforeEach(async () => {
  alertRules.length = 0;
  alertChannels.length = 0;
  workspaceRow.monthlyBudgetCents = null;
  app = createApp();
  token = await login();
});

const auth = () => ({ Authorization: `Bearer ${token}` });

describe("GET /forecast", () => {
  it("returns the latest workspace forecast", async () => {
    const res = await request(app).get("/api/workspaces/w1/finops/forecast").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.forecast.projectedMonthEndCents).toBe(9000);
  });
});

describe("budget", () => {
  it("reads and updates the workspace budget", async () => {
    const get0 = await request(app).get("/api/workspaces/w1/finops/budget").set(auth());
    expect(get0.body.data.monthlyBudgetCents).toBeNull();

    const put = await request(app)
      .put("/api/workspaces/w1/finops/budget")
      .set(auth())
      .send({ monthlyBudgetCents: 50_000 });
    expect(put.status).toBe(200);
    expect(put.body.data.monthlyBudgetCents).toBe(50_000);
  });

  it("rejects an invalid budget payload", async () => {
    const res = await request(app)
      .put("/api/workspaces/w1/finops/budget")
      .set(auth())
      .send({ monthlyBudgetCents: -5 });
    expect(res.status).toBe(400);
  });
});

describe("alert rules CRUD", () => {
  it("creates, lists, patches, and deletes a rule", async () => {
    const create = await request(app)
      .post("/api/workspaces/w1/finops/rules")
      .set(auth())
      .send({ name: "80% projected", thresholdPct: 80 });
    expect(create.status).toBe(201);
    const ruleId = create.body.data.rule.id;

    const list = await request(app).get("/api/workspaces/w1/finops/rules").set(auth());
    expect(list.body.data.rules).toHaveLength(1);

    const patch = await request(app)
      .patch(`/api/workspaces/w1/finops/rules/${ruleId}`)
      .set(auth())
      .send({ enabled: false });
    expect(patch.status).toBe(200);
    expect(patch.body.data.rule.enabled).toBe(false);

    const del = await request(app).delete(`/api/workspaces/w1/finops/rules/${ruleId}`).set(auth());
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);
  });

  it("rejects an out-of-range threshold", async () => {
    const res = await request(app)
      .post("/api/workspaces/w1/finops/rules")
      .set(auth())
      .send({ name: "bad", thresholdPct: 0 });
    expect(res.status).toBe(400);
  });
});

describe("forecast with project scope", () => {
  it("accepts a projectId query param", async () => {
    const res = await request(app)
      .get("/api/workspaces/w1/finops/forecast?projectId=p1")
      .set(auth());
    expect(res.status).toBe(200);
  });
});

describe("not-found paths", () => {
  it("returns 404 when patching an unknown rule", async () => {
    const res = await request(app)
      .patch("/api/workspaces/w1/finops/rules/missing")
      .set(auth())
      .send({ enabled: false });
    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting an unknown rule", async () => {
    const res = await request(app).delete("/api/workspaces/w1/finops/rules/missing").set(auth());
    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting an unknown channel", async () => {
    const res = await request(app).delete("/api/workspaces/w1/finops/channels/missing").set(auth());
    expect(res.status).toBe(404);
  });
});

describe("alert events", () => {
  it("lists fired alert events", async () => {
    const res = await request(app).get("/api/workspaces/w1/finops/events").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.data.events).toHaveLength(1);
  });
});

describe("chargeback PDF", () => {
  it("streams a PDF attachment", async () => {
    const res = await request(app).get("/api/workspaces/w1/finops/chargeback.pdf").set(auth());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });
});

describe("alert channels", () => {
  it("creates a webhook channel and never leaks the secret on list", async () => {
    const create = await request(app).post("/api/workspaces/w1/finops/channels").set(auth()).send({
      type: "webhook",
      target: "https://hooks.example.com/finops",
      secret: "super-secret-signing-key",
    });
    expect(create.status).toBe(201);
    expect(JSON.stringify(create.body)).not.toContain("super-secret-signing-key");

    const list = await request(app).get("/api/workspaces/w1/finops/channels").set(auth());
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain("super-secret-signing-key");
  });
});
