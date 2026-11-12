/**
 * #2332 — the UI hides the operations and developer pages from everyone who
 * is not a system admin. Hiding a link is not access control (OWASP A01), so
 * this proves, through the real application against a real (migrated SQLite)
 * database, that the server refuses what the UI hides.
 *
 * 1. Every admin-only route a hidden page calls answers 403 to a `reader`, a
 *    `developer`, a `coordinator` and a `developer` from another workspace,
 *    and lets an admin past authorization. That covers the five pages whose
 *    routes the server already refused (#2330's table: Configuration,
 *    Trigger writes, Vault writes and reveal, the leaderboard trigger and the
 *    domain and online eval panels) and the two leaderboard reads, which
 *    carried authentication only until this issue gave them `admin.read`.
 *    Because the outsider is refused too, no admin-only route returns another
 *    workspace's data to a non-admin.
 * 2. The reads that stay open to every role, because project pages use them,
 *    are scoped: a developer from another workspace gets no row, or the
 *    unknown-id 404, where a member gets the project's row.
 *
 * Routes the permission matrix grants to `coordinator` (Scheduler and MCP
 * management, task cancel/retry, hook writes) or `developer` (`mcp.read`,
 * task retry) are hidden only, by decision: see the PR for #2332.
 */
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
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { getPermissionsForRole } = await import("@metis/shared");

type Method = "get" | "post" | "put" | "patch" | "delete";
type Role = "admin" | "coordinator" | "developer" | "reader";

const PA = "proj-a-2332"; // in ws-a
const TRIGGER = "trig-a-2332";
const TASK = "task-a-2332";

/** The admin-only routes behind each hidden page. Bodies are ones an admin gets a 4xx for. */
const ADMIN_ONLY: ReadonlyArray<{ page: string; method: Method; path: string; body?: object }> = [
  { page: "Configuration", method: "get", path: "/api/admin/config" },
  { page: "Configuration", method: "get", path: "/api/admin/config/audit" },
  { page: "Configuration", method: "put", path: "/api/admin/config/not-a-config-key" },
  { page: "Configuration", method: "delete", path: "/api/admin/config/not-a-config-key" },
  { page: "Configuration", method: "get", path: "/api/settings/env" },
  { page: "Configuration", method: "post", path: "/api/security-eval/run", body: { projectId: 1 } },
  { page: "Triggers", method: "post", path: `/api/projects/${PA}/triggers` },
  { page: "Triggers", method: "patch", path: `/api/projects/${PA}/triggers/${TRIGGER}` },
  { page: "Triggers", method: "delete", path: `/api/projects/${PA}/triggers/no-such-trigger` },
  { page: "Vault", method: "post", path: "/api/vault" },
  { page: "Vault", method: "post", path: "/api/vault/no-such-secret/rotate" },
  { page: "Vault", method: "delete", path: "/api/vault/no-such-secret" },
  { page: "Vault", method: "get", path: "/api/vault/no-such-secret/reveal" },
  { page: "Eval", method: "get", path: "/api/eval/leaderboard" },
  { page: "Eval", method: "get", path: "/api/eval/leaderboard/runs/no-such-run" },
  { page: "Eval", method: "post", path: "/api/eval/leaderboard/run" },
  { page: "Eval", method: "get", path: "/api/eval/domain/runs" },
  { page: "Eval", method: "get", path: "/api/eval/domain/runs/no-such-run" },
  { page: "Eval", method: "get", path: "/api/eval/online/windows" },
  { page: "Eval", method: "get", path: "/api/eval/online/status" },
];

const NON_ADMINS = [
  { who: "a reader", userId: "u-reader-2332" },
  { who: "a developer", userId: "u-dev-2332" },
  { who: "a coordinator", userId: "u-coord-2332" },
  { who: "a developer from another workspace", userId: "u-out-2332" },
] as const;

const USERS: ReadonlyArray<{ id: string; role: Role; workspaces: string[] }> = [
  { id: "u-admin-2332", role: "admin", workspaces: [] },
  { id: "u-reader-2332", role: "reader", workspaces: ["ws-a-2332"] },
  { id: "u-dev-2332", role: "developer", workspaces: ["ws-a-2332"] },
  { id: "u-coord-2332", role: "coordinator", workspaces: ["ws-a-2332"] },
  { id: "u-out-2332", role: "developer", workspaces: ["ws-b-2332"] },
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2332 — the server refuses what the UI hides from non-admins (real app, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let app: Application;

    const tokenOf = (userId: string) => {
      const u = USERS.find((x) => x.id === userId)!;
      return issueTokens({
        userId: u.id,
        username: u.id,
        role: u.role,
        permissions: getPermissionsForRole(u.role),
        workspaces: u.workspaces,
      }).accessToken;
    };

    let ip = 0;
    const call = (method: Method, path: string, userId: string, body: object = {}) => {
      ip += 1;
      return request(app)
        [method](path)
        .set("X-Forwarded-For", `198.51.100.${ip % 250}`)
        .set("Authorization", `Bearer ${tokenOf(userId)}`)
        .send(body);
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("2332-admin-only-pages");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      for (const u of USERS) {
        await db.user.create({
          data: { id: u.id, username: u.id, displayName: u.id, email: `${u.id}@example.test` },
        });
      }
      for (const ws of ["ws-a-2332", "ws-b-2332"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const u of USERS) {
        for (const ws of u.workspaces) {
          await db.workspaceMember.create({
            data: { workspaceId: ws, userId: u.id, role: "member" },
          });
        }
      }
      await db.project.create({
        data: { id: PA, name: PA, slug: PA, createdById: "u-dev-2332", workspaceId: "ws-a-2332" },
      });
      await db.trigger.create({
        data: { id: TRIGGER, projectId: PA, name: "nightly", source: "webhook" },
      });
      await db.task.create({ data: { id: TASK, projectId: PA, type: "analysis" } });
      app = createApp();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("1. every admin-only route a hidden page calls refuses every non-admin", () => {
      it.each(ADMIN_ONLY.flatMap((route) => NON_ADMINS.map((caller) => ({ ...route, ...caller }))))(
        "$page: $method $path refuses $who",
        async ({ method, path, body, userId }) => {
          const res = await call(method, path, userId, body);
          // A project route answers an outsider the unknown-project 404 before
          // it checks the role, so it does not confirm the project exists.
          const outsiderOnProject = userId === "u-out-2332" && path.startsWith("/api/projects/");
          expect(res.status).toBe(outsiderOnProject ? 404 : 403);
          expect(res.body.success).toBe(false);
          expect(JSON.stringify(res.body)).not.toContain("nightly");
        },
      );

      it.each(ADMIN_ONLY)(
        "$page: $method $path lets an admin past authorization",
        async ({ method, path, body }) => {
          const res = await call(method, path, "u-admin-2332", body);
          expect([401, 403]).not.toContain(res.status);
        },
      );

      it("refuses a trigger write without changing the trigger", async () => {
        const res = await call("patch", `/api/projects/${PA}/triggers/${TRIGGER}`, "u-coord-2332", {
          name: "renamed",
        });
        expect(res.status).toBe(403);
        const row = await db.trigger.findUnique({ where: { id: TRIGGER } });
        expect(row?.name).toBe("nightly");
      });
    });

    describe("2. the reads left open to every role are scoped to the caller's projects", () => {
      it("GET /api/tasks lists the project's task to a member and nothing to an outsider", async () => {
        const member = await call("get", "/api/tasks", "u-reader-2332");
        expect(member.status).toBe(200);
        expect(member.body.data.items.map((t: { id: string }) => t.id)).toContain(TASK);

        const outsider = await call("get", "/api/tasks", "u-out-2332");
        expect(outsider.status).toBe(200);
        expect(outsider.body.data.items.map((t: { id: string }) => t.id)).not.toContain(TASK);

        const asked = await call("get", `/api/tasks?projectId=${PA}`, "u-out-2332");
        expect(asked.body.data).toEqual({ items: [], total: 0 });
      });

      it("GET /api/projects/:p/triggers lists to a member and 404s an outsider", async () => {
        const member = await call("get", `/api/projects/${PA}/triggers`, "u-reader-2332");
        expect(member.status).toBe(200);
        expect(JSON.stringify(member.body.data)).toContain(TRIGGER);

        const outsider = await call("get", `/api/projects/${PA}/triggers`, "u-out-2332");
        expect(outsider.status).toBe(404);
        expect(JSON.stringify(outsider.body)).not.toContain(TRIGGER);
      });

      it("GET /api/projects/:p/hooks reads to a member developer and 404s an outsider", async () => {
        const member = await call("get", `/api/projects/${PA}/hooks`, "u-dev-2332");
        expect(member.status).toBe(200);
        const outsider = await call("get", `/api/projects/${PA}/hooks`, "u-out-2332");
        expect(outsider.status).toBe(404);
      });
    });
  },
);
