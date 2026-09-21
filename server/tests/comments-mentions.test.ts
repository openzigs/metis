/**
 * Issue #281 — regression test: posting a comment that contains an `@mention`
 * must succeed (201), regardless of whether the mentioned usernames resolve to
 * real users. Previously an `@mention` body returned 500.
 *
 * Unlike comments.test.ts, this suite does NOT mock the mentions module — it
 * exercises the REAL `dispatchMentions` → `fanOutMentions` → `resolveUsernames`
 * path so it would catch any regression where mention handling 500s the
 * comment-creation response.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ---- Mocks (prisma + auth only — mentions module is REAL) -------------------

const mockPrisma = {
  requirement: { findUnique: vi.fn() },
  commentThread: { create: vi.fn() },
  // User + Mention are driven by the real mention fan-out path.
  user: { findMany: vi.fn() },
  mention: { upsert: vi.fn(), updateMany: vi.fn() },
  project: { findMany: vi.fn() },
  // #614 — no stored rows: inApp × mention defaults ON (send).
  notificationPreference: { findMany: vi.fn(async () => []) },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: unknown }).user = {
      userId: "user-1",
      username: "alice",
      role: "admin",
    };
    next();
  },
}));
vi.mock("../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
// Socket registry returns null in tests (no live IO) — fan-out must tolerate it.
vi.mock("../src/lib/socket/registry.js", () => ({
  getSocketServer: vi.fn(() => null),
}));

const { requirementCommentsRouter } = await import("../src/routes/comments.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/requirements/:requirementId/comments", requirementCommentsRouter());
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

function stubThread(body: string) {
  mockPrisma.requirement.findUnique.mockResolvedValue({ id: "req-1", projectId: "proj-1" });
  mockPrisma.commentThread.create.mockResolvedValue({
    id: "thread-1",
    requirementId: "req-1",
    title: null,
    resolved: false,
    createdAt: new Date("2024-01-01"),
    updatedAt: new Date("2024-01-01"),
    comments: [
      {
        id: "comment-1",
        threadId: "thread-1",
        authorId: "user-1",
        body,
        editedAt: null,
        deletedAt: null,
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-01-01"),
        author: { id: "user-1", username: "alice", displayName: "Alice" },
      },
    ],
  });
}

// Allow the fire-and-forget fan-out microtasks to settle before assertions.
const flush = () => new Promise((r) => setTimeout(r, 10));

describe("POST comment with @mentions (real fan-out path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.mention.upsert.mockResolvedValue({});
    mockPrisma.mention.updateMany.mockResolvedValue({ count: 1 });
  });

  afterAll(() => vi.restoreAllMocks());

  it("returns 201 with a resolvable AND an unresolvable mention", async () => {
    // `@admin` resolves; `@nope` does not (findMany returns only admin).
    mockPrisma.user.findMany.mockResolvedValue([{ id: "u-admin", username: "admin" }]);
    stubThread("Please review cc @admin and @nope");

    const res = await request(createApp())
      .post("/requirements/req-1/comments")
      .send({ body: "Please review cc @admin and @nope" });

    expect(res.status).toBe(201);
    expect(res.body.data.comments[0].body).toContain("@admin");

    await flush();
    // Resolvable mention persisted; unresolvable one silently skipped (no throw).
    expect(mockPrisma.mention.upsert).toHaveBeenCalledTimes(1);
    expect(mockPrisma.mention.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          commentId_mentionedUserId: { commentId: "comment-1", mentionedUserId: "u-admin" },
        },
      }),
    );
  });

  it("returns 201 even when mention persistence throws (never 500s the request)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([{ id: "u-admin", username: "admin" }]);
    mockPrisma.mention.upsert.mockRejectedValue(new Error("DB exploded"));
    stubThread("cc @admin");

    const res = await request(createApp())
      .post("/requirements/req-1/comments")
      .send({ body: "cc @admin" });

    expect(res.status).toBe(201);
    await flush(); // ensure the rejected fan-out does not surface late
  });

  it("returns 201 for a plain body with no mentions", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    stubThread("just a plain comment");

    const res = await request(createApp())
      .post("/requirements/req-1/comments")
      .send({ body: "just a plain comment" });

    expect(res.status).toBe(201);
    await flush();
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });
});
