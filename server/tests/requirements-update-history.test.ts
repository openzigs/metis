/**
 * Epic #770 / Issue #771 — PUT /api/requirements/:id now appends version history.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  requirement: { findUnique: vi.fn(), update: vi.fn() },
  requirementVersion: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  assignment: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn(), delete: vi.fn() },
  $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockPrisma)),
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: unknown }).user = { userId: "user-1", username: "alice", role: "admin" };
    next();
  },
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Pass-through optimistic lock — concurrency is covered by optimistic-lock.test.ts.
vi.mock("../src/middleware/optimistic-lock.js", () => ({
  optimisticLock: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../src/routes/comments.js", () => ({
  requirementCommentsRouter: () => express.Router(),
}));

const { requirementsCollaborationRouter } = await import("../src/routes/requirements.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/requirements", requirementsCollaborationRouter());
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { statusCode?: number; code?: string; message?: string };
      res
        .status(e.statusCode ?? 500)
        .json({ error: { code: e.code ?? "INTERNAL", message: e.message } });
    },
  );
  return app;
}

const EXISTING = {
  id: "req-1",
  version: 2,
  title: "Old",
  body: "Body",
  priority: "low",
  type: "feature",
  labels: "[]",
  storyPoints: null,
  reviewStatus: null,
};

describe("PUT /requirements/:id with version history", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
  });

  it("bumps the version and appends a history row when a field changes", async () => {
    mockPrisma.requirement.findUnique.mockResolvedValue(EXISTING);
    mockPrisma.requirement.update.mockResolvedValue({
      id: "req-1",
      version: 3,
      updatedAt: new Date("2026-05-05T00:00:00Z"),
    });
    mockPrisma.requirementVersion.create.mockResolvedValue({});

    const res = await request(app).put("/requirements/req-1").send({ title: "New", reason: "fix" });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(3);
    expect(mockPrisma.requirementVersion.create).toHaveBeenCalledTimes(1);
    const createArg = mockPrisma.requirementVersion.create.mock.calls[0][0] as {
      data: { version: number; actorId: string; reason: string; changedFields: string };
    };
    expect(createArg.data.version).toBe(3);
    expect(createArg.data.actorId).toBe("user-1");
    expect(createArg.data.reason).toBe("fix");
    expect(JSON.parse(createArg.data.changedFields)).toEqual({ title: { from: "Old", to: "New" } });
  });

  it("does not append a history row for a no-op update", async () => {
    mockPrisma.requirement.findUnique.mockResolvedValue(EXISTING);
    mockPrisma.requirement.update.mockResolvedValue({
      id: "req-1",
      version: 2,
      updatedAt: new Date("2026-05-05T00:00:00Z"),
    });

    const res = await request(app).put("/requirements/req-1").send({ title: "Old" });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(mockPrisma.requirementVersion.create).not.toHaveBeenCalled();
  });

  it("returns 404 when the requirement does not exist", async () => {
    mockPrisma.requirement.findUnique.mockResolvedValue(null);
    const res = await request(app).put("/requirements/missing").send({ title: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
  });

  it("rejects an invalid patch with 400", async () => {
    const res = await request(app).put("/requirements/req-1").send({ priority: "nonsense" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
