/**
 * Epic #609 / Issue #620 — Baseline REST API tests.
 *
 * Covers: RBAC (real `requirePermission` against the shared registry — read
 * for all roles, manual create for `review.admin` only), list, contents with
 * as-of-pin snapshot reconstruction (later edits must NOT leak in), compare
 * (added / removed / changed with field-level diffs / unchanged),
 * cross-project compare rejection, manual creation pinning CURRENT versions
 * transactionally with an audit row, duplicate-name conflicts, and
 * immutability (no update/delete surface).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ---- Mocks -----------------------------------------------------------------

const mockPrisma = {
  project: { findUnique: vi.fn() },
  requirement: { findMany: vi.fn() },
  requirementVersion: { findMany: vi.fn() },
  baseline: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  auditLog: { create: vi.fn() },
  $transaction: vi.fn(),
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

// Mutable test-user — mutate `role` between tests. The REAL
// `requirePermission` middleware runs against the shared RBAC registry.
const testUser = {
  userId: "user-1",
  username: "alice",
  role: "coordinator",
  permissions: [],
};

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: typeof testUser }).user = { ...testUser };
    next();
  },
}));

const { baselinesRouter, projectBaselinesRouter } = await import("../src/routes/baselines.js");

// ---- App factory -----------------------------------------------------------

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/projects/:projectId/baselines", projectBaselinesRouter());
  app.use("/baselines", baselinesRouter());
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { statusCode?: number; code?: string; message?: string };
      res.status(e.statusCode ?? 500).json({
        error: { code: e.code ?? "INTERNAL", message: e.message ?? "?" },
      });
    },
  );
  return app;
}

// ---- Fixtures ----------------------------------------------------------------

const USER_REF = { id: "user-9", username: "bob", displayName: "Bob" };

function makeBaseline(overrides: Record<string, unknown> = {}) {
  return {
    id: "base-a",
    projectId: "proj-1",
    reviewRequestId: "rev-1",
    name: "Sprint 4 sign-off",
    description: "",
    createdById: "user-9",
    createdAt: new Date("2026-07-01T00:00:00Z"),
    createdBy: USER_REF,
    reviewRequest: { id: "rev-1", title: "Sprint 4 sign-off", status: "approved" },
    items: [{ id: "bi-1", baselineId: "base-a", requirementId: "req-1", version: 2 }],
    ...overrides,
  };
}

/**
 * Requirement req-1 is CURRENTLY at v3 (priority high); the baseline pins v2
 * (priority medium — the v3 edit happened after approval). v1 was the
 * creation state with the original title.
 */
function makeRequirementRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    version: 3,
    title: "Login must support SSO",
    body: "body",
    priority: "high",
    type: "functional",
    labels: null,
    storyPoints: 5,
    reviewStatus: "approved",
    deletedAt: null,
    ...overrides,
  };
}

const VERSION_ROWS = [
  {
    requirementId: "req-1",
    version: 3,
    changedFields: JSON.stringify({ priority: { from: "medium", to: "high" } }),
    actorId: "user-1",
    reason: null,
    createdAt: new Date("2026-07-02T00:00:00Z"),
  },
  {
    requirementId: "req-1",
    version: 2,
    changedFields: JSON.stringify({ title: { from: "Login", to: "Login must support SSO" } }),
    actorId: "user-1",
    reason: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
  },
];

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  vi.clearAllMocks();
  testUser.role = "coordinator";
  testUser.userId = "user-1";
  mockPrisma.$transaction.mockImplementation(
    async (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
  );
  app = createApp();
});

// ---- List --------------------------------------------------------------------

describe("GET /projects/:projectId/baselines", () => {
  beforeEach(() => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: "proj-1" });
    mockPrisma.baseline.findMany.mockResolvedValue([
      { ...makeBaseline(), items: undefined, _count: { items: 3 } },
    ]);
    mockPrisma.baseline.count.mockResolvedValue(1);
  });

  it("lists project baselines with item counts", async () => {
    const res = await request(app).get("/projects/proj-1/baselines");
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(1);
    expect(res.body.data.baselines[0]).toMatchObject({
      id: "base-a",
      name: "Sprint 4 sign-off",
      itemCount: 3,
      reviewRequest: { id: "rev-1", status: "approved" },
    });
    expect(res.body.data.baselines[0]._count).toBeUndefined();
  });

  it("is readable by the reader role (review.read)", async () => {
    testUser.role = "reader";
    const res = await request(app).get("/projects/proj-1/baselines");
    expect(res.status).toBe(200);
  });

  it("404s for an unknown project", async () => {
    mockPrisma.project.findUnique.mockResolvedValue(null);
    const res = await request(app).get("/projects/nope/baselines");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("clamps pagination inputs", async () => {
    await request(app).get("/projects/proj-1/baselines?page=2&pageSize=99999");
    const args = mockPrisma.baseline.findMany.mock.calls[0][0];
    expect(args.skip).toBeGreaterThan(0);
    expect(args.take).toBeLessThanOrEqual(100);
  });
});

// ---- Contents ------------------------------------------------------------------

describe("GET /baselines/:baselineId", () => {
  beforeEach(() => {
    mockPrisma.baseline.findUnique.mockResolvedValue(makeBaseline());
    mockPrisma.requirement.findMany.mockResolvedValue([makeRequirementRow()]);
    mockPrisma.requirementVersion.findMany.mockResolvedValue(VERSION_ROWS);
  });

  it("renders each requirement AS OF its pinned version, not current state", async () => {
    const res = await request(app).get("/baselines/base-a");
    expect(res.status).toBe(200);
    const item = res.body.data.items[0];
    expect(item.requirementId).toBe("req-1");
    expect(item.version).toBe(2);
    // Pinned v2: title already renamed, but priority still "medium" — the v3
    // edit that bumped priority to "high" happened AFTER the baseline.
    expect(item.snapshot.title).toBe("Login must support SSO");
    expect(item.snapshot.priority).toBe("medium");
    expect(item.current).toMatchObject({ version: 3, deleted: false });
  });

  it("flags soft-deleted requirements while still rendering their snapshot", async () => {
    mockPrisma.requirement.findMany.mockResolvedValue([
      makeRequirementRow({ deletedAt: new Date() }),
    ]);
    const res = await request(app).get("/baselines/base-a");
    expect(res.status).toBe(200);
    expect(res.body.data.items[0].current.deleted).toBe(true);
    expect(res.body.data.items[0].snapshot.priority).toBe("medium");
  });

  it("404s for an unknown baseline", async () => {
    mockPrisma.baseline.findUnique.mockResolvedValue(null);
    const res = await request(app).get("/baselines/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("BASELINE_NOT_FOUND");
  });
});

// ---- Compare -------------------------------------------------------------------

describe("GET /baselines/:idA/compare/:idB", () => {
  /**
   * Baseline A pins req-1@2 and req-2@1; baseline B pins req-1@3 and req-3@1.
   * Expected: req-3 added, req-2 removed, req-1 changed (priority medium→high).
   */
  function primeCompareMocks() {
    const baselineA = makeBaseline({
      id: "base-a",
      items: [
        { id: "bi-1", baselineId: "base-a", requirementId: "req-1", version: 2 },
        { id: "bi-2", baselineId: "base-a", requirementId: "req-2", version: 1 },
      ],
    });
    const baselineB = makeBaseline({
      id: "base-b",
      name: "Sprint 5 sign-off",
      reviewRequestId: "rev-2",
      items: [
        { id: "bi-3", baselineId: "base-b", requirementId: "req-1", version: 3 },
        { id: "bi-4", baselineId: "base-b", requirementId: "req-3", version: 1 },
      ],
    });
    mockPrisma.baseline.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === "base-a") return Promise.resolve(baselineA);
      if (where.id === "base-b") return Promise.resolve(baselineB);
      return Promise.resolve(null);
    });
    mockPrisma.requirement.findMany.mockResolvedValue([
      makeRequirementRow(),
      makeRequirementRow({ id: "req-2", version: 1, title: "Removed requirement" }),
      makeRequirementRow({ id: "req-3", version: 1, title: "Added requirement" }),
    ]);
    mockPrisma.requirementVersion.findMany.mockResolvedValue(VERSION_ROWS);
  }

  it("returns added / removed / changed / unchanged between two baselines", async () => {
    primeCompareMocks();
    const res = await request(app).get("/baselines/base-a/compare/base-b");
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.baselineA).toMatchObject({ id: "base-a" });
    expect(data.baselineB).toMatchObject({ id: "base-b" });
    expect(data.added).toEqual([
      expect.objectContaining({ requirementId: "req-3", version: 1, title: "Added requirement" }),
    ]);
    expect(data.removed).toEqual([
      expect.objectContaining({ requirementId: "req-2", version: 1, title: "Removed requirement" }),
    ]);
    expect(data.unchanged).toEqual([]);
    expect(data.changed).toHaveLength(1);
    // Field-level diff derived from the RequirementVersion changedFields replay.
    expect(data.changed[0]).toMatchObject({
      requirementId: "req-1",
      fromVersion: 2,
      toVersion: 3,
      changedFields: { priority: { from: "medium", to: "high" } },
    });
  });

  it("rejects comparing baselines from different projects", async () => {
    primeCompareMocks();
    mockPrisma.baseline.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(
        where.id === "base-a"
          ? makeBaseline({ id: "base-a" })
          : makeBaseline({ id: "base-b", projectId: "proj-OTHER" }),
      ),
    );
    const res = await request(app).get("/baselines/base-a/compare/base-b");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BASELINE_PROJECT_MISMATCH");
  });

  it("404s when either baseline is missing", async () => {
    primeCompareMocks();
    const res = await request(app).get("/baselines/base-a/compare/nope");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("BASELINE_NOT_FOUND");
  });
});

// ---- Manual create ---------------------------------------------------------------

describe("POST /projects/:projectId/baselines", () => {
  beforeEach(() => {
    mockPrisma.project.findUnique.mockResolvedValue({ id: "proj-1" });
    mockPrisma.requirement.findMany.mockResolvedValue([
      makeRequirementRow(),
      makeRequirementRow({ id: "req-2", version: 1 }),
    ]);
    mockPrisma.baseline.create.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve({ ...makeBaseline(), ...data, id: "base-new", items: undefined }),
    );
  });

  it("pins the CURRENT version of every project requirement and audits in-transaction", async () => {
    const res = await request(app)
      .post("/projects/proj-1/baselines")
      .send({ name: "Manual milestone", description: "Q3 freeze" });
    expect(res.status).toBe(201);

    const createArgs = mockPrisma.baseline.create.mock.calls[0][0].data;
    expect(createArgs).toMatchObject({
      projectId: "proj-1",
      name: "Manual milestone",
      createdById: "user-1",
    });
    expect(createArgs.items.create).toEqual([
      { requirementId: "req-1", version: 3 },
      { requirementId: "req-2", version: 1 },
    ]);
    // Manual baselines are not tied to a review.
    expect(createArgs.reviewRequestId).toBeUndefined();

    const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe("baseline.create");
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("scopes to an explicit requirementIds subset, 404ing on unknown ids", async () => {
    // Where-aware mock: only req-1 / req-2 exist in the project.
    mockPrisma.requirement.findMany.mockImplementation(
      ({ where }: { where: { id?: { in: string[] } } }) => {
        const existing = [makeRequirementRow(), makeRequirementRow({ id: "req-2", version: 1 })];
        const ids = where.id?.in;
        return Promise.resolve(ids ? existing.filter((r) => ids.includes(r.id)) : existing);
      },
    );
    const res = await request(app)
      .post("/projects/proj-1/baselines")
      .send({ name: "Subset", requirementIds: ["req-1", "req-404"] });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("BASELINE_ITEM_NOT_FOUND");
  });

  it("rejects an empty baseline (no requirements in project)", async () => {
    mockPrisma.requirement.findMany.mockResolvedValue([]);
    const res = await request(app).post("/projects/proj-1/baselines").send({ name: "Empty" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("EMPTY_BASELINE");
  });

  it("409s on a duplicate baseline name within the project", async () => {
    mockPrisma.baseline.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    const res = await request(app).post("/projects/proj-1/baselines").send({ name: "Dup" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BASELINE_NAME_TAKEN");
  });

  it("rejects an invalid payload", async () => {
    const res = await request(app).post("/projects/proj-1/baselines").send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("requires review.admin — developer and reader are forbidden", async () => {
    for (const role of ["developer", "reader"]) {
      testUser.role = role;
      const res = await request(app).post("/projects/proj-1/baselines").send({ name: "X" });
      expect(res.status).toBe(403);
    }
    expect(mockPrisma.baseline.create).not.toHaveBeenCalled();
  });
});

// ---- Immutability -----------------------------------------------------------------

describe("baseline immutability", () => {
  it.each(["put", "patch", "delete"] as const)("exposes no %s surface", async (method) => {
    const res = await request(app)[method]("/baselines/base-a");
    expect(res.status).toBe(404);
  });

  it("exposes no delete surface on baseline items either", async () => {
    const res = await request(app).delete("/baselines/base-a/items/bi-1");
    expect(res.status).toBe(404);
  });
});
