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
const mockNotification = prisma.notification as {
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
        read: false,
        createdAt: new Date().toISOString(),
      },
    ];
    mockNotification.findMany.mockResolvedValue(items);
    mockNotification.count.mockResolvedValue(1);

    const res = await request(makeApp()).get("/notifications");

    expect(res.status).toBe(200);
    // Must use the { success, data } envelope — the UI's apiFetch returns
    // `payload.data`, so a bare body silently drops the persisted history.
    expect(res.body.success).toBe(true);
    expect(res.body.data.notifications).toHaveLength(1);
    expect(res.body.data.notifications[0].id).toBe("n-1");
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

describe("PATCH /notifications/:id/read", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks a notification read and returns updated item + unread count", async () => {
    const existing = {
      id: "n-1",
      userId: "u-alice",
      type: "mention",
      title: "t",
      message: "m",
      read: false,
      createdAt: new Date().toISOString(),
    };
    const updated = { ...existing, read: true };
    mockNotification.findFirst.mockResolvedValue(existing);
    mockNotification.update.mockResolvedValue(updated);
    mockNotification.count.mockResolvedValue(0);

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
