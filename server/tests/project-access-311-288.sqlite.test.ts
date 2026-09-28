/**
 * #311 — `/api/mcp` routes that act on an EXISTING server by id, and the
 * unfiltered lists, reached a `scope: "project"` server in a project the caller
 * cannot access. #288 — `GET /api/custom-agents?projectId=` listed another
 * project's agents.
 *
 * Proven through the REAL routers against a REAL SQLite database built from the
 * migration chain. Two workspaces: `ws-a` (project `proj-a-0311`) and `ws-b`
 * (project `proj-b-0311`). The attacker is `u-b`, a coordinator in `ws-b` — a
 * role that holds `mcp.manage`, `mcp.read` and `mcp.write`, so every refusal
 * below is the project check, never the role check. Each refusal asserts the
 * 404 is byte-identical to an unknown id's AND that the server row is exactly
 * as it was. Positive controls: the same-workspace coordinator `u-a`, a system
 * admin, and `u-b` on a GLOBAL server (still role-gated only), so a check that
 * refuses everyone cannot pass.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { mcpRouter } = await import("../src/routes/mcp.js");
const { customAgentsRouter } = await import("../src/routes/custom-agents.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");

type Role = "admin" | "coordinator" | "developer" | "reader";
type Method = "get" | "post" | "put" | "patch" | "delete";

const PA = "proj-a-0311";
const PB = "proj-b-0311";
const CAPS = JSON.stringify([{ name: "echo", risk: "low", inputSchema: { type: "object" } }]);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#311 / #288 — by-id MCP routes and the custom-agent list check the caller's project access",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const token = (userId: string, role: Role, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
    let ADMIN = "";
    let A = ""; // coordinator in ws-a — same-workspace positive control
    let B = ""; // coordinator in ws-b — the attacker

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/mcp", mcpRouter());
      a.use("/api/custom-agents", customAgentsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: Method, url: string, bearer: string, body?: Record<string, unknown>) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${bearer}`);
      return body ? r.send(body) : r;
    };

    let seq = 0;
    /** A fresh server per test, so a state-changing positive control never leaks. */
    const makeServer = async (scope: "global" | "project", projectId: string | null) => {
      seq += 1;
      const row = await db.mCPServer.create({
        data: {
          id: `mcp-311-${seq}`,
          scope,
          projectId,
          label: `srv-311-${seq}`,
          transport: "http",
          url: "https://example.test/mcp",
          capabilities: CAPS,
        },
      });
      return row.id;
    };
    const rowOf = (id: string) => db.mCPServer.findUnique({ where: { id } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("311-288-project-access");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      setMCPRegistry(
        new MCPRegistryService(
          new MCPLifecycleManager({
            resolveEnv: async (e) => e,
            transportFactory: () => {
              throw new Error("no MCP transport in this test");
            },
          }),
        ),
      );
      for (const id of ["u-admin", "u-a", "u-b"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of ["ws-a", "ws-b"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      await db.workspaceMember.create({
        data: { workspaceId: "ws-a", userId: "u-a", role: "owner" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-b", userId: "u-b", role: "owner" },
      });
      for (const [id, ws] of [
        [PA, "ws-a"],
        [PB, "ws-b"],
      ]) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-admin", workspaceId: ws },
        });
      }
      await db.customAgent.create({ data: { id: "ca-311-a", projectId: PA, name: "agent-a" } });
      await db.customAgent.create({ data: { id: "ca-311-b", projectId: PB, name: "agent-b" } });
      await db.customAgent.create({
        data: { id: "ca-311-builtin", projectId: null, name: "builtin-311", isBuiltIn: true },
      });

      ADMIN = token("u-admin", "admin", []);
      A = token("u-a", "coordinator", ["ws-a"]);
      B = token("u-b", "coordinator", ["ws-b"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setMCPRegistry(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── #311 — every by-id route ────────────────────────────────────────────
    interface RouteCase {
      name: string;
      method: Method;
      path: (id: string) => string;
      body?: Record<string, unknown>;
    }
    const byIdRoutes: RouteCase[] = [
      { name: "GET /:id", method: "get", path: (id) => `/api/mcp/${id}` },
      {
        name: "PATCH /:id",
        method: "patch",
        path: (id) => `/api/mcp/${id}`,
        body: { url: "https://attacker.example.test/mcp" },
      },
      { name: "DELETE /:id", method: "delete", path: (id) => `/api/mcp/${id}` },
      { name: "POST /:id/start", method: "post", path: (id) => `/api/mcp/${id}/start` },
      { name: "POST /:id/stop", method: "post", path: (id) => `/api/mcp/${id}/stop` },
      { name: "POST /:id/restart", method: "post", path: (id) => `/api/mcp/${id}/restart` },
      { name: "POST /:id/test", method: "post", path: (id) => `/api/mcp/${id}/test` },
      {
        name: "GET /servers/:id/tools",
        method: "get",
        path: (id) => `/api/mcp/servers/${id}/tools`,
      },
      {
        name: "POST /servers/:id/tools/:tool/test",
        method: "post",
        path: (id) => `/api/mcp/servers/${id}/tools/echo/test`,
        body: { args: {} },
      },
      {
        name: "GET /servers/:id/integrity/diff",
        method: "get",
        path: (id) => `/api/mcp/servers/${id}/integrity/diff`,
      },
      {
        name: "POST /servers/:id/integrity/approve-snapshot",
        method: "post",
        path: (id) => `/api/mcp/servers/${id}/integrity/approve-snapshot`,
      },
      {
        name: "PATCH /servers/:id/governance",
        method: "patch",
        path: (id) => `/api/mcp/servers/${id}/governance`,
        body: { toolAllowlist: ["attacker-only"], requireApproval: true },
      },
    ];

    describe.each(byIdRoutes)("/api/mcp $name", ({ method, path, body }) => {
      it("a cross-workspace coordinator gets the unknown-id 404 and the row is unchanged", async () => {
        const id = await makeServer("project", PA);
        const before = await rowOf(id);
        const res = await call(method, path(id), B, body);
        expect(res.status).toBe(404);
        const unknown = await call(method, path("mcp-311-does-not-exist"), B, body);
        expect(unknown.status).toBe(404);
        // Indistinguishable from an unknown id — no project/server enumeration.
        expect(res.body).toEqual(unknown.body);
        expect(res.body.data).toBeUndefined();
        expect(await rowOf(id)).toEqual(before);
      });

      it("the same-workspace coordinator and a system admin are not refused", async () => {
        for (const who of [A, ADMIN]) {
          const id = await makeServer("project", PA);
          const res = await call(method, path(id), who, body);
          expect(res.status, `${res.status} ${JSON.stringify(res.body)}`).not.toBe(404);
          expect(res.status).toBeLessThan(500);
        }
      });

      it("a GLOBAL server stays role-gated only: the other workspace's coordinator reaches it", async () => {
        const id = await makeServer("global", null);
        const res = await call(method, path(id), B, body);
        expect(res.status, `${res.status} ${JSON.stringify(res.body)}`).not.toBe(404);
        expect(res.status).toBeLessThan(500);
      });
    });

    it("a project-scoped server with no project is unreachable to a non-admin (never widened)", async () => {
      const id = await makeServer("project", null);
      expect((await call("get", `/api/mcp/${id}`, A)).status).toBe(404);
      expect((await call("get", `/api/mcp/${id}`, ADMIN)).status).toBe(200);
    });

    // ── #311 — the unfiltered lists ─────────────────────────────────────────
    describe("unfiltered lists", () => {
      let inA = "";
      let inB = "";
      let glob = "";
      beforeAll(async () => {
        inA = await makeServer("project", PA);
        inB = await makeServer("project", PB);
        glob = await makeServer("global", null);
      });
      const idsOf = (res: request.Response) =>
        (res.body.data.items as Array<{ id: string }>).map((s) => s.id);

      it("GET /api/mcp omits another workspace's project servers, keeps globals and the caller's own", async () => {
        const b = idsOf(await call("get", "/api/mcp", B));
        expect(b).toContain(inB);
        expect(b).toContain(glob);
        expect(b).not.toContain(inA);
        const a = idsOf(await call("get", "/api/mcp", A));
        expect(a).toContain(inA);
        expect(a).toContain(glob);
        expect(a).not.toContain(inB);
        const admin = idsOf(await call("get", "/api/mcp", ADMIN));
        expect(admin).toEqual(expect.arrayContaining([inA, inB, glob]));
      });

      it("GET /api/mcp?scope=project narrows the same way", async () => {
        const b = idsOf(await call("get", "/api/mcp?scope=project", B));
        expect(b).toContain(inB);
        expect(b).not.toContain(inA);
        expect(b).not.toContain(glob);
      });

      it("GET /api/mcp/export omits another workspace's project servers", async () => {
        const labelOf = async (id: string) => (await rowOf(id))!.label;
        const b = await call("get", "/api/mcp/export", B);
        expect(b.status).toBe(200);
        expect(b.text).not.toContain(await labelOf(inA));
        expect(b.text).toContain(await labelOf(inB));
        expect(b.text).toContain(await labelOf(glob));
        const admin = await call("get", "/api/mcp/export", ADMIN);
        expect(admin.text).toContain(await labelOf(inA));
        expect(admin.text).toContain(await labelOf(inB));
      });
    });

    // ── #288 — GET /api/custom-agents?projectId= ───────────────────────────
    describe("GET /api/custom-agents?projectId=", () => {
      const namesOf = (res: request.Response) =>
        (res.body.data as Array<{ id: string }>).map((a) => a.id);

      it("another workspace's project: 404 with no agents in the body", async () => {
        const res = await call("get", `/api/custom-agents?projectId=${PA}`, B);
        expect(res.status).toBe(404);
        expect(res.body.data).toBeUndefined();
        expect(JSON.stringify(res.body)).not.toContain("agent-a");
      });

      it("the project's own member and a system admin list its agents plus the built-ins", async () => {
        for (const who of [A, ADMIN]) {
          const res = await call("get", `/api/custom-agents?projectId=${PA}`, who);
          expect(res.status).toBe(200);
          expect(namesOf(res)).toEqual(expect.arrayContaining(["ca-311-a", "ca-311-builtin"]));
          expect(namesOf(res)).not.toContain("ca-311-b");
        }
      });

      it("the attacker's own project still lists (built-ins stay visible, includeBuiltIns=0 drops them)", async () => {
        const res = await call("get", `/api/custom-agents?projectId=${PB}`, B);
        expect(res.status).toBe(200);
        expect(namesOf(res)).toEqual(expect.arrayContaining(["ca-311-b", "ca-311-builtin"]));
        expect(namesOf(res)).not.toContain("ca-311-a");
        const noBuiltIns = await call(
          "get",
          `/api/custom-agents?projectId=${PB}&includeBuiltIns=0`,
          B,
        );
        expect(namesOf(noBuiltIns)).toEqual(["ca-311-b"]);
      });

      it("no projectId: the built-ins alone, for any signed-in user", async () => {
        const res = await call("get", "/api/custom-agents", B);
        expect(res.status).toBe(200);
        expect(namesOf(res)).toContain("ca-311-builtin");
        expect(namesOf(res)).not.toContain("ca-311-a");
      });
    });
  },
);
