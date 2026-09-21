/**
 * POST /api/ai/sessions/:id/messages — async-default behavior.
 *
 * Async is the default: with no `async` param (or any value other than an
 * explicit opt-out) the endpoint submits a background run and returns 202.
 * Only an explicit `?async=false` / `?async=0` returns a 400 pointing callers
 * at /api/ai/chat — the prior 501 dead-end is gone.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const mockPrisma = {
  aISession: { findUnique: vi.fn() },
};
vi.mock("../lib/prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: { userId: string } }).user = { userId: "user-1" };
    next();
  },
}));

const mockSubmit = vi.fn();
vi.mock("../lib/async/runner.js", () => ({
  getAsyncRunner: () => ({ submit: mockSubmit }),
}));

vi.mock("../lib/ai/model-switch.js", () => ({
  ModelSwitchError: class extends Error {},
  switchModel: vi.fn(),
}));
vi.mock("../lib/ai/plan-mode.js", () => ({
  PlanStateError: class extends Error {},
  decidePlan: vi.fn(),
  getCurrentPlan: vi.fn(),
  recordPendingPlan: vi.fn(),
}));
vi.mock("../lib/ai/session-snapshot.js", () => ({
  SessionSnapshotError: class extends Error {},
  listResumable: vi.fn(),
  rehydrate: vi.fn(),
}));
vi.mock("../lib/async/compaction.js", () => ({ compactSession: vi.fn() }));

const { aiSdkRouter } = await import("./ai-sdk.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/", aiSdkRouter());
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { statusCode?: number; status?: number; code?: string; message?: string };
      res
        .status(e.statusCode ?? e.status ?? 500)
        .json({ error: { code: e.code ?? "INTERNAL", message: e.message ?? "?" } });
    },
  );
  return app;
}

describe("POST /sessions/:id/messages", () => {
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    // assertOwner lookup + handler lookup both resolve to an owned, projected session.
    mockPrisma.aISession.findUnique
      .mockResolvedValueOnce({ userId: "user-1", deletedAt: null })
      .mockResolvedValueOnce({ projectId: "proj-1" });
    mockSubmit.mockResolvedValue({ id: "run-1" });
  });

  it("defaults to async (no param) — returns 202 with a runId", async () => {
    const res = await request(app).post("/sessions/sess-1/messages").send({ content: "hello" });
    expect(res.status).toBe(202);
    expect(res.body.data.runId).toBe("run-1");
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    expect(mockSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-1", sessionId: "sess-1", kind: "chat" }),
    );
  });

  it("explicit ?async=false returns 400 pointing at /api/ai/chat", async () => {
    const res = await request(app)
      .post("/sessions/sess-1/messages?async=false")
      .send({ content: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SYNC_NOT_SUPPORTED");
    expect(res.body.error.message).toContain("/api/ai/chat");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("explicit ?async=0 also returns 400", async () => {
    const res = await request(app)
      .post("/sessions/sess-1/messages?async=0")
      .send({ content: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SYNC_NOT_SUPPORTED");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("rejects an invalid body with 400 BAD_REQUEST before any submit", async () => {
    mockPrisma.aISession.findUnique.mockReset();
    mockPrisma.aISession.findUnique.mockResolvedValueOnce({ userId: "user-1", deletedAt: null });
    const res = await request(app).post("/sessions/sess-1/messages").send({ content: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("returns 404 when the session is not found in the handler lookup", async () => {
    mockPrisma.aISession.findUnique.mockReset();
    mockPrisma.aISession.findUnique
      .mockResolvedValueOnce({ userId: "user-1", deletedAt: null })
      .mockResolvedValueOnce(null);
    const res = await request(app).post("/sessions/sess-1/messages").send({ content: "hello" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("returns 400 NO_PROJECT when the session has no project", async () => {
    mockPrisma.aISession.findUnique.mockReset();
    mockPrisma.aISession.findUnique
      .mockResolvedValueOnce({ userId: "user-1", deletedAt: null })
      .mockResolvedValueOnce({ projectId: null });
    const res = await request(app).post("/sessions/sess-1/messages").send({ content: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_PROJECT");
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
