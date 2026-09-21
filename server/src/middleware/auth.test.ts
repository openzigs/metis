/**
 * Unit tests for the auth/authz 401-vs-403 taxonomy (#412, epic #404).
 *
 * The api-client classifies 401s by the `error.code` the server emits, so these
 * tests lock in the contract it depends on:
 *   • requireAuth emits 401 with a refresh-eligible auth-expiry code
 *     (AUTH_REQUIRED / TOKEN_EXPIRED / TOKEN_INVALID).
 *   • requirePermission emits 403 FORBIDDEN for an authz denial — NEVER a 401 —
 *     so a permission failure never enters the client's refresh/logout path.
 *
 * OWASP A01/A09: codes are generic, stable strings; no token contents, secrets,
 * or sensitive detail leak into the code or message.
 */
import { describe, it, expect } from "vitest";
import type { Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { AuthPayload } from "@metis/shared";
import { vi } from "vitest";
vi.mock("../lib/prisma.js", () => ({
  prisma: {
    user: { findFirst: vi.fn() },
    userRole: { findFirst: vi.fn(), findMany: vi.fn() },
    workspaceMember: { findMany: vi.fn() },
  },
}));
import { prisma } from "../lib/prisma.js";
import { refreshAuthenticatedUser, requireAuth } from "./auth.js";
import { requirePermission } from "./require-permission.js";
import { AppError } from "./error-handler.js";

// Match the secret the JWT verifier reads. tests/setup.ts sets JWT_SECRET; fall
// back to the dev default the verifier uses when the env var is unset.
const SECRET = process.env.JWT_SECRET ?? "dev-only-jwt-secret-do-not-use-in-production";

function signAccess(payload: Record<string, unknown>, opts: jwt.SignOptions = {}): string {
  return jwt.sign(payload, SECRET, opts);
}

/** Invoke a middleware and capture whatever it passes to next(). */
function run(
  handler: ReturnType<typeof requirePermission> | typeof requireAuth,
  req: Partial<Request>,
): { error: unknown; called: boolean } {
  let error: unknown;
  let called = false;
  handler(req as Request, {} as Response, (err?: unknown) => {
    called = true;
    error = err;
  });
  return { error, called };
}

describe("requireAuth — auth-expiry 401 taxonomy", () => {
  it("emits 401 AUTH_REQUIRED when no token is present", () => {
    const { error } = run(requireAuth, { headers: {} });
    expect(error).toBeInstanceOf(AppError);
    const e = error as AppError;
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe("AUTH_REQUIRED");
  });

  it("emits 401 TOKEN_EXPIRED for an expired access token", () => {
    // Backdate iat/exp so the token is already past its expiry window.
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = signAccess({
      userId: "u1",
      username: "alice",
      role: "reader",
      permissions: [],
      iat: nowSec - 7200,
      exp: nowSec - 3600,
    });
    const { error } = run(requireAuth, {
      headers: { authorization: `Bearer ${expired}` },
    });
    expect(error).toBeInstanceOf(AppError);
    const e = error as AppError;
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe("TOKEN_EXPIRED");
  });

  it("emits 401 TOKEN_INVALID for a malformed token", () => {
    const { error } = run(requireAuth, {
      headers: { authorization: "Bearer not.a.real.jwt" },
    });
    expect(error).toBeInstanceOf(AppError);
    const e = error as AppError;
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe("TOKEN_INVALID");
  });

  it("normalizes a wrong-kind token (refresh used as access) to 401 TOKEN_INVALID", () => {
    const refresh = signAccess({
      userId: "u1",
      username: "alice",
      role: "reader",
      permissions: [],
      type: "refresh",
      tokenId: "t1",
    });
    const { error } = run(requireAuth, {
      headers: { authorization: `Bearer ${refresh}` },
    });
    expect(error).toBeInstanceOf(AppError);
    const e = error as AppError;
    // Must NOT degrade to a 500 or surface an authz code — it stays a clean,
    // refresh-eligible 401 so the client never boots the user on a server error
    // and never mistakes a bad token for a permission denial.
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe("TOKEN_INVALID");
    expect(e.code).not.toBe("FORBIDDEN");
  });

  it("accepts a valid access token and calls next() with no error", () => {
    const valid = signAccess(
      { userId: "u1", username: "alice", role: "reader", permissions: [] } satisfies Omit<
        AuthPayload,
        "iat" | "exp"
      >,
      { expiresIn: "1h" },
    );
    const req: Partial<Request> = { headers: { authorization: `Bearer ${valid}` } };
    const { error, called } = run(requireAuth, req);
    expect(called).toBe(true);
    expect(error).toBeUndefined();
    expect((req as Request).user?.username).toBe("alice");
  });

  it("reads the token from the accessToken cookie when no Authorization header", () => {
    const valid = signAccess(
      { userId: "u1", username: "alice", role: "reader", permissions: [] },
      { expiresIn: "1h" },
    );
    const req = {
      headers: {},
      cookies: { accessToken: valid },
    } as unknown as Partial<Request>;
    const { error } = run(requireAuth, req);
    expect(error).toBeUndefined();
  });
});

describe("requirePermission — authz denials are 403 FORBIDDEN, never 401", () => {
  it("emits 403 FORBIDDEN when an authenticated user lacks the permission", () => {
    // `reader` does not carry `project.delete`.
    const handler = requirePermission("project.delete");
    const req = {
      user: { userId: "u1", username: "alice", role: "reader", permissions: [] },
    } as unknown as Partial<Request>;
    const { error } = run(handler, req);
    expect(error).toBeInstanceOf(AppError);
    const e = error as AppError;
    // The contract the client keys off: authz is 403/FORBIDDEN, NOT a 401.
    expect(e.statusCode).toBe(403);
    expect(e.code).toBe("FORBIDDEN");
  });

  it("emits 401 AUTH_REQUIRED (not 403) when there is no authenticated user", () => {
    const handler = requirePermission("project.delete");
    const { error } = run(handler, {} as Partial<Request>);
    const e = error as AppError;
    expect(e.statusCode).toBe(401);
    expect(e.code).toBe("AUTH_REQUIRED");
  });

  it("calls next() with no error when the role carries the permission", () => {
    // `admin` carries every permission, including `project.read`.
    const handler = requirePermission("project.read");
    const req = {
      user: { userId: "u1", username: "admin", role: "admin", permissions: [] },
    } as unknown as Partial<Request>;
    const { error, called } = run(handler, req);
    expect(called).toBe(true);
    expect(error).toBeUndefined();
  });
});

describe("refreshAuthenticatedUser — generated-doc routes use current DB role/workspaces", () => {
  it.each([false, true])(
    "selects highest valid explicit role regardless of row order (reverse=%s)",
    async (reverse) => {
      const roles = [
        { source: "scim", role: { key: "reader" } },
        { source: "local", role: { key: "coordinator" } },
        { source: "unknown", role: { key: "invalid" } },
        { source: "provider", role: { key: "admin" } },
      ];
      vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "u1", username: "alice" } as never);
      vi.mocked(prisma.userRole.findMany).mockResolvedValue(
        (reverse ? roles.reverse() : roles) as never,
      );
      vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue([
        { workspaceId: "w1" },
      ] as never);
      const req = {
        user: { userId: "u1", username: "alice", role: "reader", permissions: [] },
      } as unknown as Request;
      await new Promise<void>((resolve, reject) => {
        refreshAuthenticatedUser(req, {} as Response, (err?: unknown) =>
          err ? reject(err) : resolve(),
        );
      });
      expect(req.user?.role).toBe("coordinator");
      expect(req.user?.permissions).toContain("project.update");
    },
  );

  it("upgrades a stale JWT reader to the current synced admin role", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "u1", username: "alice" } as never);
    vi.mocked(prisma.userRole.findMany).mockResolvedValue([{ role: { key: "admin" } }] as never);
    vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue([{ workspaceId: "w1" }] as never);
    const req = {
      user: { userId: "u1", username: "alice", role: "reader", permissions: [] },
    } as unknown as Request;

    await new Promise<void>((resolve, reject) => {
      refreshAuthenticatedUser(req, {} as Response, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(req.user).toMatchObject({
      userId: "u1",
      username: "alice",
      role: "admin",
      workspaces: ["w1"],
    });
  });

  it("prevents stale-token role escalation after revocation", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "u1", username: "alice" } as never);
    vi.mocked(prisma.userRole.findMany).mockResolvedValue([{ role: { key: "reader" } }] as never);
    vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue([{ workspaceId: "w1" }] as never);
    const req = {
      user: { userId: "u1", username: "alice", role: "admin", permissions: ["project.update"] },
    } as unknown as Request;

    await new Promise<void>((resolve, reject) => {
      refreshAuthenticatedUser(req, {} as Response, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const { error } = run(requirePermission("project.update"), req);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).statusCode).toBe(403);
    expect((error as AppError).code).toBe("FORBIDDEN");
  });

  it("falls back to reader when a local role row was removed", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "u1",
      username: "alice",
      authRolesInitializedAt: null,
    } as never);
    vi.mocked(prisma.userRole.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue([{ workspaceId: "w1" }] as never);
    const req = {
      user: { userId: "u1", username: "alice", role: "admin", permissions: ["project.update"] },
    } as unknown as Request;

    await new Promise<void>((resolve, reject) => {
      refreshAuthenticatedUser(req, {} as Response, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(req.user?.role).toBe("reader");
    const { error } = run(requirePermission("project.update"), req);
    expect((error as AppError).code).toBe("FORBIDDEN");
  });

  it("keeps an intentionally revoked no-role account at reader after live refresh", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: "u1",
      username: "alice",
      authRolesInitializedAt: new Date("2026-09-17T00:00:00.000Z"),
    } as never);
    vi.mocked(prisma.userRole.findMany).mockResolvedValue([] as never);
    vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue([{ workspaceId: "w1" }] as never);
    const req = {
      user: { userId: "u1", username: "alice", role: "admin", permissions: ["project.update"] },
    } as unknown as Request;

    await new Promise<void>((resolve, reject) => {
      refreshAuthenticatedUser(req, {} as Response, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(req.user?.role).toBe("reader");
    const { error } = run(requirePermission("project.update"), req);
    expect((error as AppError).code).toBe("FORBIDDEN");
  });

  it("prefers an explicit SCIM reader override over a provider admin row", async () => {
    vi.mocked(prisma.user.findFirst).mockResolvedValue({ id: "u1", username: "alice" } as never);
    vi.mocked(prisma.userRole.findMany).mockResolvedValue([
      { role: { key: "admin" }, source: "provider" },
      { role: { key: "reader" }, source: "scim" },
    ] as never);
    vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue([{ workspaceId: "w1" }] as never);
    const req = {
      user: { userId: "u1", username: "alice", role: "admin", permissions: ["project.update"] },
    } as unknown as Request;

    await new Promise<void>((resolve, reject) => {
      refreshAuthenticatedUser(req, {} as Response, (err?: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });

    expect(req.user?.role).toBe("reader");
  });
});
