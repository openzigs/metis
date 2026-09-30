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
  aISession: { findFirst: vi.fn() },
  project: { findUnique: vi.fn() },
};
vi.mock("../lib/prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../middleware/auth.js", () => ({
  requireAuth: (req: unknown, _res: unknown, next: () => void) => {
    (req as { user: unknown }).user = {
      userId: "user-1",
      role: "developer",
      workspaces: ["ws-1"],
    };
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
  listResumable: vi.fn(),
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
  const owned = (over: Record<string, unknown> = {}) => ({
    id: "sess-1",
    userId: "user-1",
    projectId: "proj-1",
    provider: "anthropic",
    deletedAt: null,
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    app = createApp();
    // `loadAuthorizedSession` (#305): an owned session whose project is in the
    // caller's workspace.
    mockPrisma.aISession.findFirst.mockResolvedValue(owned());
    mockPrisma.project.findUnique.mockResolvedValue({
      workspaceId: "ws-1",
      workspace: { deletedAt: null, members: [{ id: "member-row" }] },
    });
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
    const res = await request(app).post("/sessions/sess-1/messages").send({ content: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("BAD_REQUEST");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller owns no such session", async () => {
    mockPrisma.aISession.findFirst.mockResolvedValue(null);
    const res = await request(app).post("/sessions/sess-1/messages").send({ content: "hello" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AI_SESSION_NOT_FOUND");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("#305 — returns 404 and submits nothing when the session's project is out of reach", async () => {
    // The caller still OWNS the session, but its project is now in a workspace
    // they are not a member of: no background run may be bound to it.
    mockPrisma.project.findUnique.mockResolvedValue({
      workspaceId: "ws-other",
      workspace: { deletedAt: null, members: [{ id: "member-row" }] },
    });
    const res = await request(app).post("/sessions/sess-1/messages").send({ content: "hello" });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("AI_SESSION_NOT_FOUND");
    expect(mockSubmit).not.toHaveBeenCalled();
  });

  it("returns 400 NO_PROJECT when the session has no project", async () => {
    mockPrisma.aISession.findFirst.mockResolvedValue(owned({ projectId: null }));
    const res = await request(app).post("/sessions/sess-1/messages").send({ content: "hello" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("NO_PROJECT");
    expect(mockSubmit).not.toHaveBeenCalled();
  });
});
