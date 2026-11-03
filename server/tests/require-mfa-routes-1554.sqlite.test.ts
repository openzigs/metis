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
 * the whole application fails when a new state-changing admin route is added
 * without the gate — keyed (#1564) on what the route requires (`admin.write` or
 * the `admin` role) as well as on the `/api/admin` prefix — or when the gate
 * runs before the route's authorization.
 */
import { Router as expressRouter } from "express";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import request from "supertest";
import type { Application, Request, Response } from "express";
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
const { authorizationOf } = await import("../src/middleware/authorization-tag.js");
const { issueTokens, verifyAccessToken } = await import("../src/lib/auth/jwt.js");
const { requireMfa } = await import("../src/lib/auth/require-mfa.js");
const { getPermissionsForRole } = await import("@metis/shared");
const { requireAuth, refreshAuthenticatedUser } = await import("../src/middleware/auth.js");

type Method = "get" | "post" | "put" | "patch" | "delete";

/** Every gated action, with a body that a permitted session gets a 4xx for, so nothing changes. */
const GATED: ReadonlyArray<{ group: 1 | 2 | 3; method: Method; path: string; body?: object }> = [
  // 1. Admin and SSO settings: every state-changing `/api/admin` route, and (#1564)
  // every state-changing route that requires `admin.write` or the `admin` role,
  // wherever it is mounted.
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
  { group: 1, method: "patch", path: "/api/projects/no-such-project/budget" },
  { group: 1, method: "post", path: "/api/projects/no-such-project/triggers" },
  { group: 1, method: "patch", path: "/api/projects/no-such-project/triggers/no-such-trigger" },
  { group: 1, method: "delete", path: "/api/projects/no-such-project/triggers/no-such-trigger" },
  { group: 1, method: "post", path: "/api/projects/no-such-project/connectors/repos/local" },
  { group: 1, method: "post", path: "/api/eval/leaderboard/run" },
  { group: 1, method: "post", path: "/api/security-eval/run", body: { projectId: 1 } },
  // 2. Vault: reveal and rotate.
  { group: 2, method: "get", path: "/api/vault/no-such-secret/reveal" },
  { group: 2, method: "post", path: "/api/vault/no-such-secret/rotate" },
  // 3. User and workspace roles.
  { group: 3, method: "post", path: "/api/admin/auth/role-reconciliation/confirm" },
  { group: 3, method: "patch", path: "/api/workspaces/no-such-ws/members/no-such-member" },
  // #1564 — removing a member revokes their workspace role.
  { group: 3, method: "delete", path: "/api/workspaces/no-such-ws/members/no-such-member" },
  { group: 3, method: "post", path: "/api/workspaces/no-such-ws/transfer" },
  { group: 3, method: "post", path: "/api/workspaces/no-such-ws/invites" },
];

/**
 * Not gated, though a POST under /api/admin: it reads a user's roles and changes
 * nothing. Keyed on the full mount path (#1564), so no other `/inspect` matches.
 */
const ADMIN_POSTS_THAT_READ = new Set(["post /api/admin/auth/role-reconciliation/inspect"]);

/**
 * Gated, but authorized inside the handler (`confirmRolesForAdmin`), not by a
 * middleware the walk can see, so the gate cannot be checked to come after it.
 */
const AUTHORIZED_IN_HANDLER = new Set(["post /api/admin/auth/role-reconciliation/confirm"]);

/** #1564 — "admin settings": what a route requires, not where it is mounted. */
const isAdminRequirement = (a: { kind: string; value: string }) =>
  (a.kind === "permission" && a.value === "admin.write") ||
  (a.kind === "role" && a.value === "admin");

const MOUNT = Symbol("mount");

interface RouteLayer {
  [MOUNT]?: string;
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  handle?: { stack?: RouteLayer[] };
}

/**
 * Express 5 keeps no mount path on a layer, so record it as `use()` adds one.
 * Returns the restore. Every `Router()` (and the app's own router) shares this
 * prototype.
 */
function recordMountPaths(): () => void {
  const proto = Object.getPrototypeOf(Object.getPrototypeOf(expressRouter())) as {
    use: (this: { stack: RouteLayer[] }, ...args: unknown[]) => unknown;
  };
  const original = proto.use;
  proto.use = function use(this: { stack: RouteLayer[] }, ...args: unknown[]) {
    const before = this.stack.length;
    const out = original.apply(this, args);
    const mount = typeof args[0] === "string" ? args[0] : "/";
    for (const layer of this.stack.slice(before)) layer[MOUNT] = mount;
    return out;
  };
  return () => {
    proto.use = original;
  };
}

const joinPath = (prefix: string, path: string) =>
  `${prefix}/${path}`.replace(/\/+/g, "/").replace(/(.)\/$/, "$1");

interface WalkedRoute {
  /** `method /full/mount/path`. */
  key: string;
  method: string;
  /** Path-level middleware that runs before the route, then the route's handlers, in order. */
  chain: unknown[];
}

/** Every route of `stack` under `prefix`, with the chain of handlers that runs for it. */
function walk(
  stack: RouteLayer[],
  prefix = "",
  inherited: ReadonlyArray<{ prefix: string; fn: unknown }> = [],
): WalkedRoute[] {
  const out: WalkedRoute[] = [];
  const middleware = [...inherited];
  for (const layer of stack) {
    if (layer.route) {
      const path = joinPath(prefix, layer.route.path);
      const before = middleware.filter((m) => path.startsWith(m.prefix)).map((m) => m.fn);
      for (const method of Object.keys(layer.route.methods).filter((m) => m !== "_all")) {
        out.push({
          key: `${method} ${path}`,
          method,
          chain: [...before, ...layer.route.stack.map((l) => l.handle)],
        });
      }
    } else if (layer.handle?.stack) {
      out.push(...walk(layer.handle.stack, joinPath(prefix, layer[MOUNT] ?? "/"), middleware));
    } else {
      middleware.push({ prefix: joinPath(prefix, layer[MOUNT] ?? "/"), fn: layer.handle });
    }
  }
  return out;
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
    const call = (method: Method, path: string, accessToken: string, body: object = {}) => {
      ip += 1;
      return request(app)
        [method](path)
        .set("X-Forwarded-For", `198.51.100.${ip % 250}`)
        .set("Authorization", `Bearer ${accessToken}`)
        .send(body);
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
      const restoreUse = recordMountPaths();
      try {
        app = createApp();
      } finally {
        restoreUse();
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it.each(GATED)(
      "$method $path: a password-only SSO session gets 403 MFA_REQUIRED",
      async ({ method, path, body }) => {
        const res = await call(method, path, session(false), body);
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
    )("$method $path: $kind is not asked for MFA", async ({ method, path, body, mfaPassed }) => {
      const res = await call(method, path, session(mfaPassed), body);
      expect(res.body.error?.code).not.toBe("MFA_REQUIRED");
      // Past authentication and authorization, into the handler.
      expect([401, 403]).not.toContain(res.status);
    });

    it("every state-changing /api/admin route, and every one that requires admin, carries the MFA gate", () => {
      const routes = walk((app as unknown as { router: { stack: RouteLayer[] } }).router.stack);
      const writes = routes.filter((r) => r.method !== "get" && r.method !== "head");
      const adminSettings = writes.filter(
        (r) =>
          !ADMIN_POSTS_THAT_READ.has(r.key) &&
          (r.key.split(" ")[1]!.startsWith("/api/admin/") ||
            r.chain.some((fn) => {
              const a = authorizationOf(fn);
              return a !== undefined && isAdminRequirement(a);
            })),
      );
      // The walk found the routes the HTTP cases above call.
      expect(adminSettings.length).toBe(
        GATED.filter((g) => g.group === 1 || g.path.startsWith("/api/admin/")).length,
      );
      for (const route of adminSettings) {
        expect({ route: route.key, gated: route.chain.includes(requireMfa) }).toEqual({
          route: route.key,
          gated: true,
        });
      }
      // Reads stay open to a password-only session.
      for (const route of routes.filter((r) => r.method === "get")) {
        expect({ route: route.key, gated: route.chain.includes(requireMfa) }).toEqual({
          route: route.key,
          gated: false,
        });
      }
    });

    it("the MFA gate runs after the route's authorization", () => {
      const routes = walk((app as unknown as { router: { stack: RouteLayer[] } }).router.stack);
      const gated = routes.filter((r) => r.chain.includes(requireMfa));
      expect(gated.length).toBeGreaterThanOrEqual(GATED.length - 1); // the reveal asserts inline
      for (const route of gated.filter((r) => !AUTHORIZED_IN_HANDLER.has(r.key))) {
        const gate = route.chain.indexOf(requireMfa);
        const authorized = route.chain.findIndex((fn) => authorizationOf(fn) !== undefined);
        expect({
          route: route.key,
          authorizedBeforeGate: authorized !== -1 && authorized < gate,
        }).toEqual({ route: route.key, authorizedBeforeGate: true });
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

    // #1564 item 2 — a session records how it signed in, and a refresh classifies
    // it by that, not by the account's `authSource`.
    it.each([
      ["ldap", "saml", "VALIDATION_ERROR"],
      ["mock", "oidc", "VALIDATION_ERROR"],
      ["saml", "ldap", "MFA_REQUIRED"],
    ] as const)(
      "a %s session of a %s account without mfaPassed, refreshed twice, gets %s on a gated route",
      async (authMode, authSource, expected) => {
        const id = `u-1564-${authMode}-${authSource}`;
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test`, authSource },
        });
        let refreshToken = issueTokens({
          userId: id,
          username: id,
          role: "admin",
          permissions: getPermissionsForRole("admin"),
          authMode,
        }).refreshToken;
        let accessToken = "";
        for (let i = 0; i < 2; i++) {
          const refreshed = await request(app)
            .post("/api/auth/refresh")
            .set("X-METIS-CSRF", "1")
            .set("Cookie", `refreshToken=${refreshToken}`);
          expect(refreshed.status).toBe(200);
          accessToken = refreshed.body.data.accessToken;
          refreshToken = refreshed.body.data.refreshToken;
        }
        const res = await call("put", "/api/admin/auth/ldap", accessToken);
        expect(res.body.error?.code).toBe(expected);
      },
    );

    it("a password sign-in records how it signed in, and makes no MFA claim", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", "203.0.113.64")
        .send({ username: "developer", password: "password" });
      expect(res.status).toBe(200);
      const claims = verifyAccessToken(res.body.data.accessToken as string);
      expect(claims.authMode).toBe("mock");
      expect(claims.mfaPassed).toBeUndefined();
    });

    // #1564 item 3 — `refreshAuthenticatedUser` replaces `req.user` with the live
    // identity; a gate mounted behind it must still see the session's verdict.
    // The chain is driven directly, not mounted on a throwaway app (an unthrottled
    // test route is a CodeQL js/missing-rate-limiting alert).
    it.each([
      [false, "MFA_REQUIRED"],
      [true, undefined],
      [undefined, undefined],
    ] as const)(
      "behind refreshAuthenticatedUser, a session with mfaPassed %s is refused with %s",
      async (mfaPassed, refusal) => {
        const req = {
          headers: { authorization: `Bearer ${session(mfaPassed)}` },
        } as unknown as Request;
        let error: unknown;
        for (const mw of [requireAuth, refreshAuthenticatedUser, requireMfa]) {
          error = await new Promise<unknown>((resolve) => {
            void mw(req, {} as Response, resolve);
          });
          if (error) break;
        }
        expect((error as { code?: string } | undefined)?.code).toBe(refusal);
        // The gate ran on the live identity (which has no `sid`), not on the token.
        expect(req.user?.userId).toBe("u-admin-1554");
        expect(req.user?.sid).toBeUndefined();
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
