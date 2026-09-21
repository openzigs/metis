/**
 * App-level integration tests against `createApp()` using supertest.
 *
 * Prisma is mocked so DB-touching paths (auth login, deep health) don't need a
 * live database; we only validate routing, middleware, and contract shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const userRows = new Map<
  string,
  { id: string; username: string; displayName: string; email: string }
>();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { username: string };
          create: { username: string; displayName: string; email: string };
        }) => {
          const existing = userRows.get(where.username);
          if (existing) return existing;
          const row = { id: `user_${userRows.size + 1}`, ...create };
          userRows.set(where.username, row);
          return row;
        },
      ),
      // `/auth/me` enriches the response with displayName/email from the User
      // row (Fix B). Look the row up by the synthetic id we minted in upsert.
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        for (const row of userRows.values()) {
          if (row.id === where.id) return row;
        }
        return null;
      }),
    },
    userRole: {},
    auditLog: {
      create: vi.fn(async () => ({})),
    },
    // Epic #404 (#413) — /refresh + /logout now consult the persistent
    // revocation store. No revoked rows exist in these happy-path tests, so
    // every lookup returns "not revoked".
    revokedRefreshToken: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    userSessionRevocation: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
  });
  return { prisma };
});

import request from "supertest";
import { createApp } from "../src/app.js";

beforeEach(() => {
  userRows.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createApp", () => {
  const app = createApp();

  it("GET /healthz returns 200 with status:ok", async () => {
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.version).toBeTypeOf("string");
  });

  it("GET /api/health returns 200", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });

  it("GET /readyz exercises the database", async () => {
    const res = await request(app).get("/readyz");
    expect(res.status).toBe(200);
    expect(res.body.checks.database.status).toBe("ok");
    expect(res.body.checks.vault.status).toBe("ok");
  });

  it("404s unknown routes with the JSON error envelope", async () => {
    const res = await request(app).get("/no-such-route");
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("attaches a correlation id and echoes it back", async () => {
    const res = await request(app).get("/healthz").set("X-Correlation-Id", "abc-123");
    expect(res.headers["x-correlation-id"]).toBe("abc-123");
  });

  it("mints a correlation id when the client does not supply one", async () => {
    const res = await request(app).get("/healthz");
    expect(res.headers["x-correlation-id"]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/i);
  });

  it("POST /api/auth/login validates payload", async () => {
    const res = await request(app).post("/api/auth/login").send({ username: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/auth/login rejects bad credentials", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_FAILED");
  });

  it("POST /api/auth/login + GET /api/auth/me happy path", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "password" });
    expect(login.status).toBe(200);
    expect(login.body.success).toBe(true);
    expect(login.body.data.accessToken).toBeTypeOf("string");
    const token = login.body.data.accessToken as string;

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.user.username).toBe("admin");
    expect(me.body.data.user.role).toBe("admin");
    // Fix B — /auth/me surfaces the real displayName + email from the User row
    // so the profile page renders them instead of the "—" fallback.
    expect(me.body.data.user.displayName).toBe("System Admin");
    expect(me.body.data.user.email).toBe("admin@metis.local");
  });

  it("GET /api/auth/me returns id (not userId) matching the login user id (#642)", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "password" });
    const token = login.body.data.accessToken as string;
    const loginUser = login.body.data.user;

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);
    expect(me.status).toBe(200);

    // Regression: the client-facing user carries `id`, never `userId`.
    expect(typeof me.body.data.user.id).toBe("string");
    expect(me.body.data.user.id).toBe(loginUser.id);
    expect(me.body.data.user).not.toHaveProperty("userId");
  });

  it("POST /api/auth/login and GET /api/auth/me return identically-shaped user objects (#642)", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "admin", password: "password" });
    const token = login.body.data.accessToken as string;

    const me = await request(app).get("/api/auth/me").set("Authorization", `Bearer ${token}`);

    // Same key set on both responses so the shape cannot drift again.
    const loginKeys = Object.keys(login.body.data.user).sort();
    const meKeys = Object.keys(me.body.data.user).sort();
    expect(meKeys).toEqual(loginKeys);
    expect(meKeys).toEqual(
      ["displayName", "email", "id", "permissions", "role", "username"].sort(),
    );
  });

  it("GET /api/auth/me without a token returns 401 AUTH_REQUIRED", async () => {
    const res = await request(app).get("/api/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("GET /api/auth/me with an invalid token returns 401 TOKEN_INVALID", async () => {
    const res = await request(app).get("/api/auth/me").set("Authorization", "Bearer not.a.jwt");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_INVALID");
  });

  it("POST /api/auth/refresh requires a refresh token", async () => {
    const res = await request(app).post("/api/auth/refresh");
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("NO_REFRESH_TOKEN");
  });

  it("POST /api/auth/refresh exchanges a refresh token for a new pair", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "developer", password: "password" });
    const refreshToken = login.body.data.refreshToken as string;
    const res = await request(app).post("/api/auth/refresh").send({ refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTypeOf("string");
  });

  it("POST /api/auth/logout clears cookies", async () => {
    const login = await request(app)
      .post("/api/auth/login")
      .send({ username: "reader", password: "password" });
    const token = login.body.data.accessToken as string;
    const res = await request(app).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const setCookie = res.headers["set-cookie"];
    const cookieStr = Array.isArray(setCookie) ? setCookie.join(";") : String(setCookie ?? "");
    expect(cookieStr).toMatch(/accessToken=;/);
    expect(cookieStr).toMatch(/refreshToken=;/);
  });
});
