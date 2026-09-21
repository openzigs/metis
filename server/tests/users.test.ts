/**
 * Issue #281 — /api/users search endpoint tests (@mention autocomplete).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

// ---- Mocks -----------------------------------------------------------------

const mockPrisma = {
  user: { findMany: vi.fn() },
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: mockPrisma }));

// Auth toggle: when `authed` is false, requireAuth rejects with 401.
let authed = true;

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: (err?: unknown) => void) => {
    if (!authed) {
      next({ statusCode: 401, code: "AUTH_REQUIRED", message: "Authentication required" });
      return;
    }
    (req as unknown as { user: unknown }).user = {
      userId: "user-1",
      username: "alice",
      role: "admin",
    };
    next();
  },
}));

const { usersRouter } = await import("../src/routes/users.js");

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/users", usersRouter());
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

describe("GET /users", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authed = true;
  });

  it("returns matching active users (id/username/displayName only)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([
      { id: "u-1", username: "admin", displayName: "Admin User" },
      { id: "u-2", username: "adam", displayName: "Adam Smith" },
    ]);

    const res = await request(createApp()).get("/users?search=ad&limit=8");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0]).toEqual({ id: "u-1", username: "admin", displayName: "Admin User" });
    // Sensitive fields must never appear.
    expect(res.body.data[0]).not.toHaveProperty("email");
    expect(res.body.data[0]).not.toHaveProperty("passwordHash");
    expect(res.body.data[0]).not.toHaveProperty("role");
  });

  it("filters to active users and selects only safe fields (no leakage)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(createApp()).get("/users?search=bob");

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "active" }),
        select: { id: true, username: true, displayName: true },
        take: 8,
      }),
    );
  });

  it("honours the limit query param (clamped)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(createApp()).get("/users?search=x&limit=3");

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 3 }));
  });

  it("clamps an over-large limit to the max (25)", async () => {
    mockPrisma.user.findMany.mockResolvedValue([]);

    await request(createApp()).get("/users?search=x&limit=9999");

    expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }));
  });

  it("requires authentication (401 without auth)", async () => {
    authed = false;

    const res = await request(createApp()).get("/users?search=admin");

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
  });
});
