/**
 * Route tests for the manual-override endpoints — Epic #294 (#304).
 *
 * Mocks `../src/lib/prisma.js` (the #289 lesson — never hit a real DB) and the
 * project-access helper so we can exercise authz + the override HTTP surface
 * deterministically. Auth uses a real signed JWT via `issueTokens`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface OverrideRow {
  id: string;
  projectId: string;
  kind: string;
  tableName: string;
  columnName: string | null;
  usageClass: string;
  access: string;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const store: { overrides: OverrideRow[]; classifications: unknown[] } = {
  overrides: [],
  classifications: [],
};
let seq = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    schemaUsageOverride: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findFirst: async ({ where }: any) =>
        store.overrides.find(
          (r) =>
            r.projectId === where.projectId &&
            r.tableName === where.tableName &&
            r.columnName === (where.columnName ?? null) &&
            r.access === where.access,
        ) ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: async ({ data }: any) => {
        seq += 1;
        const row: OverrideRow = {
          id: `ov_${seq}`,
          projectId: data.projectId,
          kind: data.kind,
          tableName: data.tableName,
          columnName: data.columnName ?? null,
          usageClass: data.usageClass,
          access: data.access,
          note: data.note ?? null,
          createdBy: data.createdBy ?? null,
          createdAt: new Date("2026-06-18T00:00:00Z"),
          updatedAt: new Date("2026-06-18T00:00:00Z"),
        };
        store.overrides.push(row);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: async ({ where, data }: any) => {
        const row = store.overrides.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      findMany: async ({ where }: any) =>
        store.overrides.filter((r) => r.projectId === where.projectId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      deleteMany: async ({ where }: any) => {
        const before = store.overrides.length;
        for (let i = store.overrides.length - 1; i >= 0; i--) {
          if (
            store.overrides[i].id === where.id &&
            store.overrides[i].projectId === where.projectId
          ) {
            store.overrides.splice(i, 1);
          }
        }
        return { count: before - store.overrides.length };
      },
    },
    schemaUsageClassification: {
      findMany: async () => store.classifications,
    },
  },
}));

// Make every project accessible to the test actor (authz path is tested elsewhere).
vi.mock("../src/lib/scheduler/project-access.js", () => ({
  isAdminActor: () => true,
  listAccessibleProjectIds: async () => ["proj1", "proj2"],
}));

import { impactAnalysisRouter } from "../src/routes/impact-analysis.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";

let token: string;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/impact-analyses", impactAnalysisRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

beforeEach(() => {
  store.overrides = [];
  store.classifications = [];
  seq = 0;
  token = issueTokens({
    userId: "u1",
    username: "alice",
    role: "developer",
    permissions: ["analysis.read", "analysis.run"],
  }).accessToken;
});

describe("manual-override routes", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(makeApp())
      .post("/api/impact-analyses/projects/proj1/usage-overrides")
      .send({ kind: "table", tableName: "orders", usageClass: "used" });
    expect(res.status).toBe(401);
  });

  it("creates an override (201) and lists it", async () => {
    const app = makeApp();
    const create = await auth(
      request(app).post("/api/impact-analyses/projects/proj1/usage-overrides").send({
        kind: "column",
        tableName: "Orders",
        columnName: "Total",
        usageClass: "used",
        access: "reads",
      }),
    );
    expect(create.status).toBe(201);
    expect(create.body.data.tableName).toBe("orders");

    const list = await auth(
      request(app).get("/api/impact-analyses/projects/proj1/usage-overrides"),
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
  });

  it("validates the request body (400)", async () => {
    const res = await auth(
      request(makeApp())
        .post("/api/impact-analyses/projects/proj1/usage-overrides")
        .send({ tableName: "orders" }), // missing kind + usageClass
    );
    expect(res.status).toBe(400);
  });

  it("deletes an override (204) and 404s when missing", async () => {
    const app = makeApp();
    const created = await auth(
      request(app)
        .post("/api/impact-analyses/projects/proj1/usage-overrides")
        .send({ kind: "table", tableName: "orders", usageClass: "used" }),
    );
    const id = created.body.data.id;
    const del = await auth(
      request(app).delete(`/api/impact-analyses/projects/proj1/usage-overrides/${id}`),
    );
    expect(del.status).toBe(204);
    const del2 = await auth(
      request(app).delete(`/api/impact-analyses/projects/proj1/usage-overrides/${id}`),
    );
    expect(del2.status).toBe(404);
  });

  it("folds the override into the classification view (precedence: manual wins)", async () => {
    store.classifications = [
      {
        id: "c1",
        projectId: "proj1",
        kind: "table",
        tableName: "orders",
        columnName: null,
        columnType: null,
        usageClass: "uncertain",
        uncertainReason: "dynamic-reference",
        evidence: "[]",
        overriddenClass: null,
        computedAt: new Date("2026-06-18T00:00:00Z"),
      },
    ];
    const app = makeApp();
    await auth(
      request(app)
        .post("/api/impact-analyses/projects/proj1/usage-overrides")
        .send({ kind: "table", tableName: "orders", usageClass: "used" }),
    );
    const view = await auth(
      request(app).get("/api/impact-analyses/projects/proj1/usage-classification"),
    );
    expect(view.status).toBe(200);
    const orders = view.body.data.find((r: { tableName: string }) => r.tableName === "orders");
    expect(orders.usageClass).toBe("used");
    expect(orders.overriddenClass).toBe("uncertain");
  });
});
