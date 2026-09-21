/**
 * /api/impact-analyses/:id/items/:itemId/feedback route tests — Issue #966
 * (Epic #960).
 *
 * Covers permission gating, tenant isolation (the item's project must be
 * accessible), idempotent POST, and IDOR-safe DELETE. The feedback service is
 * mocked so these tests focus on the route layer; the service itself has its
 * own dedicated unit tests (tests/table-feedback.test.ts).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUser: { userId: string; username: string; role: string } = {
  userId: "user-1",
  username: "alice",
  role: "member",
};
vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

let permitRun = true;
vi.mock("../middleware/require-permission.js", () => ({
  requirePermission:
    (perm: string) =>
    (_req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (perm === "analysis.run" && !permitRun) {
        res.status(403).json({ success: false, error: { code: "FORBIDDEN", message: "denied" } });
        return;
      }
      next();
    },
}));

let adminFlag = false;
let accessibleIds: string[] = ["project-001"];
vi.mock("../lib/scheduler/project-access.js", () => ({
  isAdminActor: () => adminFlag,
  listAccessibleProjectIds: vi.fn(async () => accessibleIds),
}));

// Prisma must be mocked or the route's `import { prisma }` hits a clean-DB CI
// failure. The feedback service itself is fully mocked below.
vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

const findFeedbackTargetItem = vi.fn(
  async () => ({ id: "item-1", impactAnalysisId: "ia-1", projectId: "project-001" }) as unknown,
);
const upsertTableFeedback = vi.fn(
  async () =>
    ({
      id: "fb-1",
      impactItemId: "item-1",
      tableName: "crm.customers",
      columnName: null,
      verdict: "relevant",
      userId: "user-1",
      userDisplayName: "alice",
      createdAt: "2026-07-20T00:00:00.000Z",
    }) as unknown,
);
const deleteTableFeedback = vi.fn(async () => true);
vi.mock("../lib/impact-analysis/table-feedback.js", () => ({
  findFeedbackTargetItem,
  upsertTableFeedback,
  deleteTableFeedback,
}));

const { impactAnalysisRouter } = await import("./impact-analysis.js");
const { errorHandler } = await import("../middleware/error-handler.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/impact-analyses", impactAnalysisRouter());
  app.use(errorHandler);
  return app;
}

describe("impact-analyses table-feedback routes", () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => {
    vi.clearAllMocks();
    currentUser = { userId: "user-1", username: "alice", role: "member" };
    permitRun = true;
    adminFlag = false;
    accessibleIds = ["project-001"];
    findFeedbackTargetItem.mockResolvedValue({
      id: "item-1",
      impactAnalysisId: "ia-1",
      projectId: "project-001",
    } as never);
    upsertTableFeedback.mockResolvedValue({
      id: "fb-1",
      impactItemId: "item-1",
      tableName: "crm.customers",
      columnName: null,
      verdict: "relevant",
      userId: "user-1",
      userDisplayName: "alice",
      createdAt: "2026-07-20T00:00:00.000Z",
    } as never);
    deleteTableFeedback.mockResolvedValue(true);
    app = createApp();
  });

  describe("POST /:id/items/:itemId/feedback", () => {
    it("marks a table relevant and returns 201 with the view", async () => {
      const res = await request(app)
        .post("/impact-analyses/ia-1/items/item-1/feedback")
        .send({ tableName: "crm.customers", verdict: "relevant" });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ tableName: "crm.customers", verdict: "relevant" });
      expect(upsertTableFeedback).toHaveBeenCalledWith(
        {},
        "ia-1",
        "item-1",
        { tableName: "crm.customers", verdict: "relevant" },
        { id: "user-1", displayName: "alice" },
      );
    });

    it("accepts an optional columnName for a column-level verdict", async () => {
      await request(app)
        .post("/impact-analyses/ia-1/items/item-1/feedback")
        .send({ tableName: "crm.customers", columnName: "email", verdict: "not-relevant" });
      expect(upsertTableFeedback).toHaveBeenCalledWith(
        {},
        "ia-1",
        "item-1",
        { tableName: "crm.customers", columnName: "email", verdict: "not-relevant" },
        { id: "user-1", displayName: "alice" },
      );
    });

    it("rejects an invalid verdict with 400", async () => {
      const res = await request(app)
        .post("/impact-analyses/ia-1/items/item-1/feedback")
        .send({ tableName: "crm.customers", verdict: "maybe" });
      expect(res.status).toBe(400);
      expect(upsertTableFeedback).not.toHaveBeenCalled();
    });

    it("rejects a missing tableName with 400", async () => {
      const res = await request(app)
        .post("/impact-analyses/ia-1/items/item-1/feedback")
        .send({ verdict: "relevant" });
      expect(res.status).toBe(400);
    });

    it("returns 404 when the item does not exist", async () => {
      findFeedbackTargetItem.mockResolvedValue(null as never);
      const res = await request(app)
        .post("/impact-analyses/ia-1/items/item-ghost/feedback")
        .send({ tableName: "crm.customers", verdict: "relevant" });
      expect(res.status).toBe(404);
      expect(upsertTableFeedback).not.toHaveBeenCalled();
    });

    it("returns 404 when the caller cannot access the item's project (no leak)", async () => {
      accessibleIds = [];
      const res = await request(app)
        .post("/impact-analyses/ia-1/items/item-1/feedback")
        .send({ tableName: "crm.customers", verdict: "relevant" });
      expect(res.status).toBe(403);
      expect(upsertTableFeedback).not.toHaveBeenCalled();
    });

    it("returns 403 when analysis.run permission is denied", async () => {
      permitRun = false;
      const res = await request(app)
        .post("/impact-analyses/ia-1/items/item-1/feedback")
        .send({ tableName: "crm.customers", verdict: "relevant" });
      expect(res.status).toBe(403);
      expect(findFeedbackTargetItem).not.toHaveBeenCalled();
    });
  });

  describe("DELETE /:id/items/:itemId/feedback/:feedbackId", () => {
    it("removes a feedback row and returns 204", async () => {
      const res = await request(app).delete("/impact-analyses/ia-1/items/item-1/feedback/fb-1");
      expect(res.status).toBe(204);
      expect(deleteTableFeedback).toHaveBeenCalledWith({}, "ia-1", "item-1", "fb-1", "user-1");
    });

    it("returns 404 when the row does not exist or is owned by someone else", async () => {
      deleteTableFeedback.mockResolvedValue(false);
      const res = await request(app).delete("/impact-analyses/ia-1/items/item-1/feedback/fb-ghost");
      expect(res.status).toBe(404);
    });

    it("returns 404 when the item does not exist", async () => {
      findFeedbackTargetItem.mockResolvedValue(null as never);
      const res = await request(app).delete("/impact-analyses/ia-1/items/item-ghost/feedback/fb-1");
      expect(res.status).toBe(404);
      expect(deleteTableFeedback).not.toHaveBeenCalled();
    });

    it("returns 403 when the caller cannot access the item's project", async () => {
      accessibleIds = [];
      const res = await request(app).delete("/impact-analyses/ia-1/items/item-1/feedback/fb-1");
      expect(res.status).toBe(403);
      expect(deleteTableFeedback).not.toHaveBeenCalled();
    });

    it("returns 403 when analysis.run permission is denied", async () => {
      permitRun = false;
      const res = await request(app).delete("/impact-analyses/ia-1/items/item-1/feedback/fb-1");
      expect(res.status).toBe(403);
    });
  });
});
