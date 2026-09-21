/**
 * Issue #542 (Epic #518) — route-level proof that the OIDC login/callback flow
 * goes through the shared SSO transaction-state store seam (instead of the old
 * in-process `oidcSessions` Map), preserving consume-once + TTL semantics.
 *
 * The default backend is the in-memory store (SSO_STATE_BACKEND unset), which is
 * correct for this single-process test. The cross-replica Postgres behaviour is
 * proven in src/lib/auth/sso-state-store-postgres.test.ts (fake shared PG) and
 * the gated tests/sso-state-store-postgres.integration.test.ts (real PG).
 *
 * We mock the OIDC provider so no real IdP is contacted: generateAuthorizationUrl
 * yields a deterministic {state,nonce,codeVerifier}, and exchangeCodeForTokens
 * echoes back a fixed user. We then assert:
 *   - login stores state (callback with that state succeeds → 302 to /dashboard),
 *   - replaying the SAME state fails (401 OIDC_STATE_MISMATCH) — consume-once,
 *   - an unknown/forged state fails (401) — rejects unknown state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// createApp wires routers that import prisma at module load — mock it so the app
// boots without a live DB (mirrors sso-providers-endpoint.test.ts). The OIDC
// callback upserts a user row and reads roles, so stub those.
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    $transaction: vi.fn(),
    role: {
      findFirst: vi.fn(async ({ where }: { where: { key: string } }) => ({
        id: `role-${where.key}`,
      })),
      upsert: vi.fn(async ({ where }: { where: { key: string } }) => ({
        id: `role-${where.key}`,
      })),
    },
    user: {
      upsert: vi.fn(async () => ({ id: "user-1", authRolesInitializedAt: null })),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
    },
    userRole: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
      create: vi.fn(async () => ({})),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    workspaceMember: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

// Mock the OIDC provider: deterministic authorize params + a fixed token result.
const FIXED = { state: "state-fixed", nonce: "nonce-fixed", codeVerifier: "verifier-fixed" };
vi.mock("../src/lib/auth/oidc-provider.js", () => ({
  generateAuthorizationUrl: vi.fn(async () => ({
    url: "https://idp.example/authorize?state=state-fixed",
    ...FIXED,
  })),
  exchangeCodeForTokens: vi.fn(async () => ({
    success: true,
    user: {
      username: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      groups: [],
      mfaPassed: true,
    },
  })),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { upsertProvider, __resetProviders } from "../src/lib/auth/sso-config.js";
import { exchangeCodeForTokens } from "../src/lib/auth/oidc-provider.js";
import { prisma } from "../src/lib/prisma.js";
import { verifyAccessToken } from "../src/lib/auth/jwt.js";

const app = createApp();

const prismaState = {
  userUpsert: { id: "user-1", authRolesInitializedAt: null as Date | null },
  userRoles: [] as Array<{ role: { key: string | null }; source?: string | null }>,
};

vi.mocked(prisma.user.upsert).mockImplementation(async () => prismaState.userUpsert as never);
vi.mocked(prisma.userRole.findMany).mockImplementation(async () => prismaState.userRoles as never);
vi.mocked(prisma.userRole.findFirst).mockImplementation(
  async () => (prismaState.userRoles[0] ?? null) as never,
);

function configureOIDC(): void {
  upsertProvider({
    name: "Okta OIDC",
    mode: "oidc",
    enabled: true,
    oidc: {
      discoveryUrl: "https://idp.example/.well-known/openid-configuration",
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://app/api/auth/oidc/callback",
      scopes: ["openid", "profile", "email"],
    },
    defaultRole: "reader",
    groupMappings: [
      { claimValue: "metis-admins", role: "admin" },
      { claimValue: "metis-readers", role: "reader" },
    ],
  });
}

beforeEach(() => {
  __resetProviders();
  configureOIDC();
  prismaState.userUpsert = { id: "user-1", authRolesInitializedAt: null };
  prismaState.userRoles = [];
  vi.mocked(prisma.$transaction).mockImplementation(
    async (fn) => (fn as (tx: typeof prisma) => Promise<unknown>)(prisma) as never,
  );
  vi.mocked(prisma.user.findFirst).mockImplementation(async () => prismaState.userUpsert as never);
  vi.mocked(prisma.userRole.deleteMany).mockImplementation(async () => {
    const before = prismaState.userRoles.length;
    prismaState.userRoles = prismaState.userRoles.filter((row) => row.source !== "provider");
    return { count: before - prismaState.userRoles.length };
  });
  vi.mocked(prisma.userRole.create).mockImplementation(async ({ data }) => {
    prismaState.userRoles.push({
      role: { key: data.roleId?.replace("role-", "") ?? null },
      source: data.source,
    });
    return data as never;
  });
  vi.mocked(prisma.user.update).mockImplementation(async () => {
    prismaState.userUpsert.authRolesInitializedAt = new Date();
    return prismaState.userUpsert as never;
  });
});

afterEach(() => {
  __resetProviders();
  vi.clearAllMocks();
});

describe("OIDC login/callback via shared SSO-state store (#542)", () => {
  it("login redirects to the IdP authorize URL and stores the transaction state", async () => {
    const res = await request(app).get("/api/auth/oidc/login");
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("idp.example/authorize");
  });

  it("callback with the stored state completes login (302 to dashboard)", async () => {
    await request(app).get("/api/auth/oidc/login"); // stashes state-fixed
    const res = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain("/dashboard");
    // Auth cookies were set.
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.join(";")).toMatch(/accessToken=/);
    const accessCookie = cookies.find((cookie) => cookie.startsWith("accessToken="));
    const accessToken = accessCookie?.split(";")[0].slice("accessToken=".length);
    expect(accessToken).toBeTruthy();
    expect(verifyAccessToken(accessToken ?? "").role).toBe("reader");
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("persists the current provider grant separately from explicit overrides", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({
      success: true,
      user: {
        username: "alice",
        displayName: "Alice",
        email: "alice@example.com",
        groups: ["metis-admins"],
        mfaPassed: true,
      },
    });
    __resetProviders();
    upsertProvider({
      name: "Okta OIDC",
      mode: "oidc",
      enabled: true,
      oidc: {
        discoveryUrl: "https://idp.example/.well-known/openid-configuration",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://app/api/auth/oidc/callback",
        scopes: ["openid", "profile", "email"],
      },
      groupMappings: [{ claimValue: "metis-admins", role: "admin" }],
      defaultRole: "reader",
    });

    await request(app).get("/api/auth/oidc/login");
    await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.userRole.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", source: "provider" },
    });
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: { userId: "user-1", roleId: "role-admin", source: "provider" },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { authRolesInitializedAt: expect.any(Date) },
    });
    expect(prismaState.userRoles).toEqual([{ role: { key: "admin" }, source: "provider" }]);
  });

  it("downgrades a provider admin grant on later login when the provider role drops", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({
      success: true,
      user: {
        username: "alice",
        displayName: "Alice",
        email: "alice@example.com",
        groups: ["metis-readers"],
        mfaPassed: true,
      },
    });
    prismaState.userUpsert = {
      id: "user-1",
      authRolesInitializedAt: new Date("2026-09-17T00:00:00.000Z"),
    };
    prismaState.userRoles = [{ role: { key: "admin" }, source: "provider" }];
    __resetProviders();
    upsertProvider({
      name: "Okta OIDC",
      mode: "oidc",
      enabled: true,
      oidc: {
        discoveryUrl: "https://idp.example/.well-known/openid-configuration",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://app/api/auth/oidc/callback",
        scopes: ["openid", "profile", "email"],
      },
      groupMappings: [
        { claimValue: "metis-admins", role: "admin" },
        { claimValue: "metis-readers", role: "reader" },
      ],
      defaultRole: "reader",
    });

    await request(app).get("/api/auth/oidc/login");
    const res = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });

    expect(res.status).toBe(302);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const accessCookie = cookies.find((cookie) => cookie.startsWith("accessToken="));
    const accessToken = accessCookie?.split(";")[0].slice("accessToken=".length);
    expect(verifyAccessToken(accessToken ?? "").role).toBe("reader");
    expect(prisma.userRole.create).toHaveBeenCalledWith({
      data: { userId: "user-1", roleId: "role-reader", source: "provider" },
    });
    expect(prismaState.userRoles).toEqual([{ role: { key: "reader" }, source: "provider" }]);
  });

  it("keeps an explicit SCIM coordinator override across a provider downgrade", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({
      success: true,
      user: {
        username: "alice",
        displayName: "Alice",
        email: "alice@example.com",
        groups: ["metis-readers"],
        mfaPassed: true,
      },
    });
    prismaState.userUpsert = {
      id: "user-1",
      authRolesInitializedAt: new Date("2026-09-17T00:00:00.000Z"),
    };
    prismaState.userRoles = [
      { role: { key: "coordinator" }, source: "scim" },
      { role: { key: "reader" }, source: "provider" },
    ];
    __resetProviders();
    upsertProvider({
      name: "Okta OIDC",
      mode: "oidc",
      enabled: true,
      oidc: {
        discoveryUrl: "https://idp.example/.well-known/openid-configuration",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://app/api/auth/oidc/callback",
        scopes: ["openid", "profile", "email"],
      },
      groupMappings: [
        { claimValue: "metis-admins", role: "admin" },
        { claimValue: "metis-readers", role: "reader" },
      ],
      defaultRole: "reader",
    });

    await request(app).get("/api/auth/oidc/login");
    const res = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });

    expect(res.status).toBe(302);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const accessCookie = cookies.find((cookie) => cookie.startsWith("accessToken="));
    const accessToken = accessCookie?.split(";")[0].slice("accessToken=".length);
    expect(verifyAccessToken(accessToken ?? "").role).toBe("coordinator");
  });

  it("keeps a revoke marker at reader on subsequent login instead of recreating provider admin", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({
      success: true,
      user: {
        username: "alice",
        displayName: "Alice",
        email: "alice@example.com",
        groups: ["metis-admins"],
        mfaPassed: true,
      },
    });
    prismaState.userUpsert = {
      id: "user-1",
      authRolesInitializedAt: new Date("2026-09-17T00:00:00.000Z"),
    };
    prismaState.userRoles = [];

    await request(app).get("/api/auth/oidc/login");
    const res = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });

    expect(res.status).toBe(302);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const accessCookie = cookies.find((cookie) => cookie.startsWith("accessToken="));
    const accessToken = accessCookie?.split(";")[0].slice("accessToken=".length);
    expect(verifyAccessToken(accessToken ?? "").role).toBe("reader");
    expect(prisma.userRole.create).not.toHaveBeenCalled();
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
    expect(prismaState.userRoles).toEqual([]);
  });

  it("preserves existing durable DB role assignments instead of overwriting them on SSO login", async () => {
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({
      success: true,
      user: {
        username: "alice",
        displayName: "Alice",
        email: "alice@example.com",
        groups: ["metis-admins"],
        mfaPassed: true,
      },
    });
    prismaState.userUpsert = {
      id: "user-1",
      authRolesInitializedAt: new Date("2026-09-17T00:00:00.000Z"),
    };
    prismaState.userRoles = [{ role: { key: "coordinator" }, source: "scim" }];
    __resetProviders();
    upsertProvider({
      name: "Okta OIDC",
      mode: "oidc",
      enabled: true,
      oidc: {
        discoveryUrl: "https://idp.example/.well-known/openid-configuration",
        clientId: "client-id",
        clientSecret: "client-secret",
        redirectUri: "https://app/api/auth/oidc/callback",
        scopes: ["openid", "profile", "email"],
      },
      groupMappings: [{ claimValue: "metis-admins", role: "admin" }],
      defaultRole: "reader",
    });

    await request(app).get("/api/auth/oidc/login");
    const res = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });

    expect(res.status).toBe(302);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    const accessCookie = cookies.find((cookie) => cookie.startsWith("accessToken="));
    const accessToken = accessCookie?.split(";")[0].slice("accessToken=".length);
    expect(verifyAccessToken(accessToken ?? "").role).toBe("coordinator");
    expect(prisma.userRole.create).not.toHaveBeenCalled();
    expect(prisma.userRole.deleteMany).not.toHaveBeenCalled();
  });

  it("CONSUME-ONCE: replaying the same state a second time is rejected (401)", async () => {
    await request(app).get("/api/auth/oidc/login");
    // First callback consumes the state.
    const first = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });
    expect(first.status).toBe(302);
    // Replay with the same state — the store already consumed (deleted) it.
    const replay = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });
    expect(replay.status).toBe(401);
    expect(replay.body.error?.code).toBe("OIDC_STATE_MISMATCH");
  });

  it("rejects an unknown/forged state that was never issued (401)", async () => {
    const res = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: "forged-state" });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("OIDC_STATE_MISMATCH");
  });

  it("rejects a callback missing code or state (400)", async () => {
    const res = await request(app).get("/api/auth/oidc/callback").query({ state: FIXED.state });
    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe("INVALID_OIDC_CALLBACK");
  });

  it("rejects a callback carrying an IdP error param (401)", async () => {
    const res = await request(app).get("/api/auth/oidc/callback").query({ error: "access_denied" });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("OIDC_AUTH_FAILED");
  });

  it("rejects when token exchange fails AFTER a valid state consume (401)", async () => {
    // Valid state is stored and consumed, but the PKCE/nonce-verified token
    // exchange fails — the callback must still 401 (and the state stays consumed).
    vi.mocked(exchangeCodeForTokens).mockResolvedValueOnce({
      success: false,
      error: "nonce mismatch",
    });
    await request(app).get("/api/auth/oidc/login");
    const res = await request(app)
      .get("/api/auth/oidc/callback")
      .query({ code: "auth-code", state: FIXED.state });
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe("OIDC_AUTH_FAILED");
  });
});
