/**
 * #1554 — the security-sensitive actions require an MFA sign-in.
 *
 * Owner's decision (2026-10-29): MFA is required for
 *   1. admin and SSO settings — every state-changing `/api/admin/*` route;
 *   2. revealing and rotating vault secrets;
 *   3. changing a user's role or workspace role.
 * Read-only pages, analysis, chat, review and publishing are not gated.
 *
 * Each gated route is called through the real application against a real
 * (migrated SQLite) database by three admin sessions: a password-only SSO
 * sign-in (`mfaPassed: false`) gets 403 `MFA_REQUIRED`; an MFA SSO sign-in
 * (`true`) and a password sign-in (mock or LDAP, no claim) do not. A walk of
 * the admin router fails when a new state-changing admin route is added
 * without the gate.
 */
import type { Router } from "express";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import type { Application } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_RATE_LIMIT_MAX = "100000";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

const { createApp } = await import("../src/app.js");
const { adminRouter } = await import("../src/routes/admin/index.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { requireMfa } = await import("../src/lib/auth/require-mfa.js");
const { getPermissionsForRole } = await import("@metis/shared");

type Method = "get" | "post" | "put" | "patch" | "delete";

/** Every gated action, with a body that a permitted session gets a 4xx for, so nothing changes. */
const GATED: ReadonlyArray<{ group: 1 | 2 | 3; method: Method; path: string }> = [
  // 1. Admin and SSO settings.
  { group: 1, method: "put", path: "/api/admin/config/not-a-config-key" },
  { group: 1, method: "delete", path: "/api/admin/config/not-a-config-key" },
  { group: 1, method: "put", path: "/api/admin/auth/providers/saml" },
  { group: 1, method: "put", path: "/api/admin/auth/providers/oidc" },
  { group: 1, method: "delete", path: "/api/admin/auth/providers/no-such-provider" },
  { group: 1, method: "post", path: "/api/admin/auth/scim/rotate-token" },
  { group: 1, method: "put", path: "/api/admin/auth/ldap" },
  { group: 1, method: "post", path: "/api/admin/auth/ldap/test" },
  { group: 1, method: "put", path: "/api/admin/token-budgets/no-such-user" },
  { group: 1, method: "delete", path: "/api/admin/embeddings/projects/no%20such/reindex" },
  { group: 1, method: "post", path: "/api/admin/embeddings/projects/no%20such/reindex" },
  // 2. Vault: reveal and rotate.
  { group: 2, method: "get", path: "/api/vault/no-such-secret/reveal" },
  { group: 2, method: "post", path: "/api/vault/no-such-secret/rotate" },
  // 3. User and workspace roles.
  { group: 3, method: "post", path: "/api/admin/auth/role-reconciliation/confirm" },
  { group: 3, method: "patch", path: "/api/workspaces/no-such-ws/members/no-such-member" },
  { group: 3, method: "post", path: "/api/workspaces/no-such-ws/transfer" },
  { group: 3, method: "post", path: "/api/workspaces/no-such-ws/invites" },
];

/** Not gated, though a POST under /api/admin: it reads a user's roles and changes nothing. */
const ADMIN_POSTS_THAT_READ = new Set(["/inspect"]);

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  handle?: { stack?: RouteLayer[] };
}

/** Every route reachable through `router`, with the handlers on it. */
function routesOf(router: { stack?: RouteLayer[] }): Array<{
  path: string;
  methods: string[];
  handlers: unknown[];
}> {
  return (router.stack ?? []).flatMap((layer) =>
    layer.route
      ? [
          {
            path: layer.route.path,
            methods: Object.keys(layer.route.methods).filter((m) => layer.route!.methods[m]),
            handlers: layer.route.stack.map((l) => l.handle),
          },
        ]
      : layer.handle?.stack
        ? routesOf(layer.handle)
        : [],
  );
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1554 — MFA-gated actions (real app, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;

    const session = (mfaPassed: boolean | undefined) =>
      issueTokens({
        userId: "u-admin-1554",
        username: "admin1554",
        role: "admin",
        permissions: getPermissionsForRole("admin"),
        ...(mfaPassed === undefined ? {} : { mfaPassed }),
      }).accessToken;

    let ip = 0;
    const call = (method: Method, path: string, accessToken: string) => {
      ip += 1;
      return request(app)
        [method](path)
        .set("X-Forwarded-For", `198.51.100.${ip % 250}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send({});
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1554-require-mfa");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      // The audit row names the actor, so the session's user exists.
      await db.user.create({
        data: {
          id: "u-admin-1554",
          username: "admin1554",
          displayName: "Admin 1554",
          email: "admin1554@example.test",
        },
      });
      app = createApp();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it.each(GATED)(
      "$method $path: a password-only SSO session gets 403 MFA_REQUIRED",
      async ({ method, path }) => {
        const res = await call(method, path, session(false));
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe("MFA_REQUIRED");
        expect(res.body.error.message).toMatch(/multi-factor authentication/);
        expect(res.body.error.message).toMatch(/Conditional Access/);
      },
    );

    it.each(
      GATED.flatMap((route) => [
        { ...route, kind: "an MFA SSO session", mfaPassed: true },
        { ...route, kind: "a password (mock/LDAP) session", mfaPassed: undefined },
      ]),
    )("$method $path: $kind is not asked for MFA", async ({ method, path, mfaPassed }) => {
      const res = await call(method, path, session(mfaPassed));
      expect(res.body.error?.code).not.toBe("MFA_REQUIRED");
      // Past authentication and authorization, into the handler.
      expect([401, 403]).not.toContain(res.status);
    });

    it("every state-changing /api/admin route carries the MFA gate", () => {
      const routes = routesOf(adminRouter() as unknown as Router & { stack: RouteLayer[] });
      const writes = routes.filter(
        (r) =>
          r.methods.some((m) => m !== "get" && m !== "head") && !ADMIN_POSTS_THAT_READ.has(r.path),
      );
      expect(writes.length).toBe(GATED.filter((g) => g.path.startsWith("/api/admin")).length);
      for (const route of writes) {
        expect({
          route: `${route.methods} ${route.path}`,
          gated: route.handlers.includes(requireMfa),
        }).toEqual({ route: `${route.methods} ${route.path}`, gated: true });
      }
      // Reads stay open to a password-only session.
      for (const route of routes.filter((r) => r.methods.every((m) => m === "get"))) {
        expect(route.handlers).not.toContain(requireMfa);
      }
    });

    it("read-only admin pages, the vault list and role inspection stay open to a password-only session", async () => {
      for (const [method, path] of [
        ["get", "/api/admin/auth/providers"],
        ["get", "/api/admin/config"],
        ["get", "/api/vault"],
        ["post", "/api/admin/auth/role-reconciliation/inspect"],
      ] as const) {
        const res = await call(method, path, session(false));
        expect({ path, code: res.body.error?.code }).not.toEqual({ path, code: "MFA_REQUIRED" });
        expect(res.status).not.toBe(403);
      }
    });

    // #1558 item 6 — a refresh token minted before #1552 carries no mfaPassed.
    it.each([
      ["saml", "MFA_REQUIRED"],
      ["oidc", "MFA_REQUIRED"],
      ["ldap", "VALIDATION_ERROR"],
    ] as const)(
      "a session from before #1552 of a %s account, once refreshed, gets %s on a gated route",
      async (authSource, expected) => {
        const id = `u-legacy-${authSource}`;
        await db.user.create({
          data: {
            id,
            username: id,
            displayName: id,
            email: `${id}@example.test`,
            authSource,
          },
        });
        const legacy = issueTokens({
          userId: id,
          username: id,
          role: "admin",
          permissions: getPermissionsForRole("admin"),
        });
        const refreshed = await request(app)
          .post("/api/auth/refresh")
          .set("X-METIS-CSRF", "1")
          .set("Cookie", `refreshToken=${legacy.refreshToken}`);
        expect(refreshed.status).toBe(200);
        const res = await call("put", "/api/admin/auth/ldap", refreshed.body.data.accessToken);
        expect(res.body.error?.code).toBe(expected);
      },
    );

    it("a refused reveal is audited as denied for MFA", async () => {
      await call("get", "/api/vault/secret-1554/reveal", session(false));
      await vi.waitFor(async () => {
        const row = await db.auditLog.findFirst({
          where: { action: "vault.reveal", targetId: "secret-1554" },
        });
        expect(row).not.toBeNull();
        expect(JSON.parse(String(row!.metadata))).toMatchObject({
          outcome: "denied",
          reason: "mfa_required",
        });
      });
    });
  },
);
