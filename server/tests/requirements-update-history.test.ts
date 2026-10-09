/**
 * Epic #770 / Issue #771 — PUT /api/requirements/:id now appends version history.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  requirement: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
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
// `sendVersionConflict` stays real: the handler answers an in-transaction
// conflict (#871) with the middleware's own 409 payload.
vi.mock("../src/middleware/optimistic-lock.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/middleware/optimistic-lock.js")>()),
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
    mockPrisma.requirement.findUnique.mockResolvedValueOnce(EXISTING).mockResolvedValueOnce({
      id: "req-1",
      version: 3,
      updatedAt: new Date("2026-05-05T00:00:00Z"),
    });
    mockPrisma.requirement.updateMany.mockResolvedValue({ count: 1 });
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
    mockPrisma.requirement.findUnique.mockResolvedValueOnce(EXISTING).mockResolvedValueOnce({
      id: "req-1",
      version: 2,
      updatedAt: new Date("2026-05-05T00:00:00Z"),
    });
    mockPrisma.requirement.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app).put("/requirements/req-1").send({ title: "Old" });

    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(mockPrisma.requirementVersion.create).not.toHaveBeenCalled();
  });

  // #871 — the middleware's check ran before the transaction; the write
  // transaction sees the row already moved on and answers the lock's 409.
  it("answers 409 VERSION_CONFLICT with a diff when the version moved under the write", async () => {
    mockPrisma.requirement.findUnique
      .mockResolvedValueOnce({ ...EXISTING, version: 3, title: "Winner" }) // in-transaction read
      .mockResolvedValueOnce({ ...EXISTING, version: 3, title: "Winner" }); // 409 diff reload

    const res = await request(app).put("/requirements/req-1").send({ title: "Loser", version: 2 });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: "VERSION_CONFLICT",
      conflict: true,
      serverVersion: 3,
      clientVersion: 2,
      diff: [{ field: "title", server: "Winner", client: "Loser" }],
    });
    expect(mockPrisma.requirement.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.requirementVersion.create).not.toHaveBeenCalled();
  });

  it("answers 404 when the requirement vanished between the conflict and the diff reload", async () => {
    mockPrisma.requirement.findUnique
      .mockResolvedValueOnce({ ...EXISTING, version: 3 })
      .mockResolvedValueOnce(null);

    const res = await request(app).put("/requirements/req-1").send({ title: "Loser", version: 2 });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
  });

  it("returns 404 when the requirement does not exist", async () => {
    mockPrisma.requirement.findUnique.mockResolvedValue(null);
    const res = await request(app).put("/requirements/missing").send({ title: "x" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("REQUIREMENT_NOT_FOUND");
  });

  // Issue #940 — the Edit dialog never shows the hidden `finding:<id>`
  // traceability label, so the labels it saves never contain it. Replacing the
  // stored list with them silently cut the requirement off from its finding.
  it("#940 — keeps the hidden finding:<id> label when the dialog saves its visible labels", async () => {
    mockPrisma.requirement.findUnique
      .mockResolvedValueOnce({ ...EXISTING, labels: JSON.stringify(["api", "finding:f-1"]) })
      .mockResolvedValueOnce({ id: "req-1", version: 3, updatedAt: new Date() });
    mockPrisma.requirement.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.requirementVersion.create.mockResolvedValue({});

    const res = await request(app)
      .put("/requirements/req-1")
      .send({ labels: ["api", "security"], version: 2 });

    expect(res.status).toBe(200);
    const written = mockPrisma.requirement.updateMany.mock.calls[0][0] as {
      data: { labels: string };
    };
    expect(JSON.parse(written.data.labels)).toEqual(["api", "security", "finding:f-1"]);
  });

  it("#940 — a save that changes nothing visible writes nothing", async () => {
    mockPrisma.requirement.findUnique
      .mockResolvedValueOnce({ ...EXISTING, labels: JSON.stringify(["api", "finding:f-1"]) })
      .mockResolvedValueOnce({ id: "req-1", version: 2, updatedAt: new Date() });

    const res = await request(app)
      .put("/requirements/req-1")
      .send({ labels: ["api"], version: 2 });

    expect(res.status).toBe(200);
    expect(mockPrisma.requirement.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.requirementVersion.create).not.toHaveBeenCalled();
  });

  it("#940 — a client cannot forge or drop a finding:<id> link through the labels", async () => {
    mockPrisma.requirement.findUnique
      .mockResolvedValueOnce({ ...EXISTING, labels: JSON.stringify(["finding:f-1"]) })
      .mockResolvedValueOnce({ id: "req-1", version: 3, updatedAt: new Date() });
    mockPrisma.requirement.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.requirementVersion.create.mockResolvedValue({});

    await request(app)
      .put("/requirements/req-1")
      .send({ labels: ["ui", "finding:forged"], version: 2 });

    const written = mockPrisma.requirement.updateMany.mock.calls[0][0] as {
      data: { labels: string };
    };
    expect(JSON.parse(written.data.labels)).toEqual(["ui", "finding:f-1"]);
  });

  it("#940 — the 409 diff shows the labels as the dialog does, without the hidden ones", async () => {
    const stored = { ...EXISTING, version: 3, labels: JSON.stringify(["api", "finding:f-1"]) };
    mockPrisma.requirement.findUnique.mockResolvedValueOnce(stored).mockResolvedValueOnce(stored);

    const res = await request(app)
      .put("/requirements/req-1")
      .send({ labels: ["ui"], version: 2 });

    expect(res.status).toBe(409);
    expect(res.body.error.diff).toEqual([{ field: "labels", server: ["api"], client: ["ui"] }]);
  });

  it("rejects an invalid patch with 400", async () => {
    const res = await request(app).put("/requirements/req-1").send({ priority: "nonsense" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});

// #330 — zod 3 accepted a slaDeadline without seconds; zod 4 alone would 400 it.
describe("POST /requirements/:id/assignments slaDeadline (zod 3 parity)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts a slaDeadline without seconds", async () => {
    mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-1" });
    mockPrisma.assignment.upsert.mockResolvedValue({ id: "asg-1" });

    const res = await request(createApp())
      .post("/requirements/req-1/assignments")
      .send({ assigneeId: "user-2", slaDeadline: "2026-01-01T10:00Z" });

    expect(res.status).toBe(201);
    const arg = mockPrisma.assignment.upsert.mock.calls[0][0];
    expect(arg.create.slaDeadline).toEqual(new Date("2026-01-01T10:00:00Z"));
  });

  it("still rejects a slaDeadline with no zone", async () => {
    const res = await request(createApp())
      .post("/requirements/req-1/assignments")
      .send({ assigneeId: "user-2", slaDeadline: "2026-01-01T10:00:00" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });
});
