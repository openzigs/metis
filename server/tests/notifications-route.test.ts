/**
 * Issue #416 — GET /notifications, PATCH /notifications/:id/read,
 * POST /notifications/read-all route tests.
 *
 * Verifies:
 *   - GET returns only the caller's notifications (never another user's).
 *   - PATCH /read marks a notification read and returns updated unread count.
 *   - POST /read-all marks all read.
 *   - Cross-user access is rejected 404 (not 403 — OWASP A01 info leak prevention).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import { errorHandler } from "../src/middleware/error-handler.js";
import { notificationsRouter } from "../src/routes/notifications.js";

// ---- Mocks ------------------------------------------------------------------

// vi.mock is hoisted — use vi.fn() directly inside the factory, NOT outer vars.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    notification: {
      findMany: vi.fn(),
      count: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    // #1447 — the batched access check for each page.
    project: { findMany: vi.fn() },
  },
}));

// Stub requireAuth to inject a known user.
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: vi.fn((req, _res, next) => {
    req.user = { userId: "u-alice", username: "alice", role: "developer", permissions: [] };
    next();
  }),
}));

// Import the mocked prisma AFTER vi.mock so we get the mock instance.
import { prisma } from "../src/lib/prisma.js";

// Typed handles to the mock functions.
// `prisma` is vi.mock'ed: these delegates are the in-memory mocks, not the fluent client.
const mockProject = prisma.project as unknown as { findMany: ReturnType<typeof vi.fn> };
const mockNotification = prisma.notification as unknown as {
  findMany: ReturnType<typeof vi.fn>;
  count: ReturnType<typeof vi.fn>;
  findFirst: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  updateMany: ReturnType<typeof vi.fn>;
};

// ---- App setup --------------------------------------------------------------

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/notifications", notificationsRouter());
  app.use(errorHandler);
  return app;
}

// ---- Tests ------------------------------------------------------------------

describe("GET /notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns notifications for the current user with unread count", async () => {
    const items = [
      {
        id: "n-1",
        userId: "u-alice",
        type: "mention",
        title: "You were mentioned",
        message: "Comment c-1",
        href: "/comments/c-1",
        payload: null,
        projectId: "p-1",
        read: false,
        createdAt: new Date().toISOString(),
      },
    ];
    mockNotification.findMany.mockResolvedValue(items);
    mockNotification.count.mockResolvedValue(1);
    mockProject.findMany.mockResolvedValue([{ id: "p-1" }]);

    const res = await request(makeApp()).get("/notifications");

    expect(res.status).toBe(200);
    // Must use the { success, data } envelope — the UI's apiFetch returns
    // `payload.data`, so a bare body silently drops the persisted history.
    expect(res.body.success).toBe(true);
    expect(res.body.data.notifications).toHaveLength(1);
    expect(res.body.data.notifications[0].id).toBe("n-1");
    expect(res.body.data.notifications[0]).toMatchObject({
      title: "You were mentioned",
      href: "/comments/c-1",
      redacted: false,
    });
    expect(res.body.data.notifications[0]).not.toHaveProperty("projectId");
    expect(res.body.data.unreadCount).toBe(1);

    // Must scope query to current user only.
    expect(mockNotification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "u-alice" }),
      }),
    );
  });

  it("never leaks another user's data — query always scoped to req.user.userId", async () => {
    mockNotification.findMany.mockResolvedValue([]);
    mockNotification.count.mockResolvedValue(0);

    await request(makeApp()).get("/notifications");

    const callArgs = mockNotification.findMany.mock.calls[0][0];
    // The where clause must be scoped to the authenticated user.
    expect(callArgs.where.userId).toBe("u-alice");
    // It must NOT be a wildcard (no undefined / null userId filter).
    expect(callArgs.where.userId).not.toBeUndefined();
  });
});

describe("GET /notifications — #1447 access re-check", () => {
  beforeEach(() => vi.clearAllMocks());

  const row = (id: string, projectId: string | null) => ({
    id,
    userId: "u-alice",
    type: "review_rejected",
    title: `title ${id}`,
    message: `message ${id}`,
    href: `/reviews/${id}`,
    payload: "{}",
    commentId: null,
    projectId,
    read: false,
    createdAt: new Date().toISOString(),
  });

  it("checks the page's distinct projects in ONE query and redacts what it cannot open", async () => {
    mockNotification.findMany.mockResolvedValue([
      row("n-1", "p-open"),
      row("n-2", "p-open"),
      row("n-3", "p-gone"),
      row("n-4", null),
    ]);
    mockNotification.count.mockResolvedValue(4);
    mockProject.findMany.mockResolvedValue([{ id: "p-open" }]);

    const res = await request(makeApp()).get("/notifications");

    expect(res.status).toBe(200);
    expect(mockProject.findMany).toHaveBeenCalledTimes(1);
    const where = mockProject.findMany.mock.calls[0][0].where;
    expect(where.id).toEqual({ in: ["p-open", "p-gone"] });
    // The canonical non-admin predicate: deleted projects closed (#1430).
    expect(where.deletedAt).toBeNull();

    const [a, b, c, d] = res.body.data.notifications;
    expect(a).toMatchObject({ title: "title n-1", redacted: false });
    expect(b).toMatchObject({ title: "title n-2", redacted: false });
    for (const hidden of [c, d]) {
      expect(hidden).toMatchObject({
        type: "unavailable",
        title: "Notification unavailable",
        message: "",
        href: null,
        payload: null,
        commentId: null,
        redacted: true,
      });
    }
    // Redacted, not hidden: the count still matches the list.
    expect(res.body.data.unreadCount).toBe(4);
  });

  it("skips the project query entirely for an empty page", async () => {
    mockNotification.findMany.mockResolvedValue([]);
    mockNotification.count.mockResolvedValue(0);

    await request(makeApp()).get("/notifications");

    expect(mockProject.findMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /notifications/:id/read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a notification read and returns updated item + unread count", async () => {
    const existing = {
      id: "n-1",
      userId: "u-alice",
      type: "mention",
      title: "t",
      message: "m",
      href: null,
      payload: null,
      projectId: "p-1",
      read: false,
      createdAt: new Date().toISOString(),
    };
    const updated = { ...existing, read: true };
    mockNotification.findFirst.mockResolvedValue(existing);
    mockNotification.update.mockResolvedValue(updated);
    mockNotification.count.mockResolvedValue(0);
    mockProject.findMany.mockResolvedValue([{ id: "p-1" }]);

    const res = await request(makeApp()).patch("/notifications/n-1/read");

    expect(res.status).toBe(200);
    expect(res.body.data.notification.read).toBe(true);
    expect(res.body.data.unreadCount).toBe(0);

    // findFirst MUST scope to { id, userId } — not just id.
    expect(mockNotification.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "n-1", userId: "u-alice" },
      }),
    );
  });

  it("returns 404 when notification belongs to a different user", async () => {
    // findFirst returns null because the row exists but userId doesn't match.
    mockNotification.findFirst.mockResolvedValue(null);

    const res = await request(makeApp()).patch("/notifications/n-other/read");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOTIFICATION_NOT_FOUND");
    // Must NOT call update for a missing-or-foreign notification.
    expect(mockNotification.update).not.toHaveBeenCalled();
  });
});

describe("POST /notifications/read-all", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks all unread notifications read for the current user", async () => {
    mockNotification.updateMany.mockResolvedValue({ count: 3 });

    const res = await request(makeApp()).post("/notifications/read-all");

    expect(res.status).toBe(200);
    expect(res.body.data.updated).toBe(3);
    expect(res.body.data.unreadCount).toBe(0);

    expect(mockNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u-alice", read: false },
        data: { read: true },
      }),
    );
  });
});

describe("notifications routes — failure paths", () => {
  beforeEach(() => vi.clearAllMocks());

  it("passes a failed access check to the error handler, never the rows unchecked (#1447)", async () => {
    mockNotification.findMany.mockResolvedValue([
      {
        id: "n-1",
        type: "mention",
        title: "secret",
        message: "secret",
        href: "/x",
        payload: null,
        projectId: "p-1",
        read: false,
      },
    ]);
    mockNotification.count.mockResolvedValue(1);
    mockProject.findMany.mockRejectedValue(new Error("db down"));

    const res = await request(makeApp()).get("/notifications");

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });

  it("returns 401 on every route when no user is attached", async () => {
    const { requireAuth } = await import("../src/middleware/auth.js");
    const passThrough = (_req: unknown, _res: unknown, next: () => void) => next();
    vi.mocked(requireAuth).mockImplementationOnce(passThrough as never);
    vi.mocked(requireAuth).mockImplementationOnce(passThrough as never);
    vi.mocked(requireAuth).mockImplementationOnce(passThrough as never);

    const app = makeApp();
    expect((await request(app).get("/notifications")).status).toBe(401);
    expect((await request(app).patch("/notifications/n-1/read")).status).toBe(401);
    expect((await request(app).post("/notifications/read-all")).status).toBe(401);
  });
});

describe("applyNotificationAccess — project-less carve-out (#1447)", () => {
  beforeEach(() => vi.clearAllMocks());

  const orphan = {
    id: "n-x",
    type: "account_alert",
    title: "Your password was changed",
    message: "m",
    href: null,
    payload: null,
    projectId: null,
  };

  it("shows a project-less row only when its type opted in", async () => {
    const { applyNotificationAccess } = await import("../src/lib/notifications/visibility.js");
    const actor = { userId: "u-alice", role: "developer", workspaces: [] };

    const [optedIn] = await applyNotificationAccess(actor, [orphan], new Set(["account_alert"]));
    expect(optedIn).toMatchObject({ title: "Your password was changed", redacted: false });

    const [defaulted] = await applyNotificationAccess(actor, [orphan]);
    expect(defaulted).toMatchObject({ title: "Notification unavailable", redacted: true });
    expect(mockProject.findMany).not.toHaveBeenCalled();
  });
});
