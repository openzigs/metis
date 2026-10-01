/**
 * #340 — four access-control follow-ups to #334, proven through the REAL
 * routers against a REAL SQLite database built from the migration chain. No
 * access helper is mocked.
 *
 *   1. A `scope: "user"` MCP server is its owner's alone: every by-id route
 *      answers another user the unknown-id 404 (row unchanged), and the
 *      unfiltered lists show a non-admin only their own user servers.
 *   2. `/api/runs/:id*` answers a run the caller cannot reach with the SAME
 *      404 body as an unknown id (it was 403).
 *   3. `PATCH`/`DELETE /api/projects/:projectId/triggers/:id` act only on a
 *      trigger of the path's project; any other answers the unknown-id 404.
 *   4. `POST /api/scheduler` checks project access BEFORE it reads the
 *      project's autopilot flag, so a foreign project's autopilot state does
 *      not leak.
 *
 * Two workspaces: `ws-a` (the owner `u-own` and a peer `u-peer`, both
 * coordinators) and `ws-b` (coordinator `u-b`). Coordinators hold `mcp.*`,
 * `analysis.read` and `scheduler.manage`, so every refusal below is the
 * object-level check, never the role check. Positive controls (owner, admin,
 * a caller's own project) keep a check that refuses everyone from passing.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import type { MCPTransportClient } from "../src/lib/mcp/types.js";
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
const { runsRouter } = await import("../src/routes/runs.js");
const { projectTriggersRouter } = await import("../src/routes/triggers.js");
const { schedulerRouter } = await import("../src/routes/scheduler.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
const { bootstrapScheduler, SCHEDULER_DEFAULTS } = await import("../src/lib/scheduler/index.js");
const { aiRouter } = await import("../src/routes/ai.js");
const { MCPToolBridge } = await import("../src/lib/mcp/tool-bridge.js");
const { __resetToolRegistrySingleton } = await import("../src/lib/ai/tool-registry.js");

type Role = "admin" | "coordinator";
type Method = "get" | "post" | "put" | "patch" | "delete";

const PA = "proj-a-0340"; // ws-a, created by u-own, autopilot ON
const PA_OFF = "proj-a-off-0340"; // ws-a, created by u-own, autopilot OFF
const PB = "proj-b-0340"; // ws-b, created by u-b, autopilot OFF
const PB_ON = "proj-b-on-0340"; // ws-b, created by u-b, autopilot ON
const NO_PROJECT = "proj-nope-0340";
const CAPS = JSON.stringify([{ name: "echo", risk: "low", inputSchema: { type: "object" } }]);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#340 — user-scope MCP ownership, the /api/runs 404, trigger by-id scoping, the scheduler autopilot oracle",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let registry: InstanceType<typeof MCPRegistryService>;
    let scheduler: ReturnType<typeof bootstrapScheduler>;

    const token = (userId: string, role: Role, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
    let ADMIN = "";
    let OWN = ""; // owner of the user-scope servers, coordinator in ws-a
    let PEER = ""; // same workspace as the owner, NOT the owner
    let B = ""; // coordinator in ws-b

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/mcp", mcpRouter());
      a.use("/api/runs", runsRouter());
      a.use("/api/projects/:projectId/triggers", projectTriggersRouter());
      a.use("/api/scheduler", schedulerRouter());
      a.use("/api/ai", aiRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (method: Method, url: string, bearer: string, body?: Record<string, unknown>) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${bearer}`);
      return body ? r.send(body) : r;
    };

    let seq = 0;
    const makeServer = async (
      scope: "global" | "project" | "user",
      owner: { projectId?: string | null; userId?: string | null } = {},
    ) => {
      seq += 1;
      const row = await db.mCPServer.create({
        data: {
          id: `mcp-340-${seq}`,
          scope,
          projectId: owner.projectId ?? null,
          userId: owner.userId ?? null,
          label: `srv-340-${seq}`,
          transport: "http",
          url: "https://example.test/mcp",
          capabilities: CAPS,
        },
      });
      return row.id;
    };
    const rowOf = (id: string) => db.mCPServer.findUnique({ where: { id } });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("340-authz-followups");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      registry = new MCPRegistryService(
        new MCPLifecycleManager({
          resolveEnv: async (e) => e,
          transportFactory: () => {
            throw new Error("no MCP transport in this test");
          },
        }),
      );
      setMCPRegistry(registry);
      scheduler = bootstrapScheduler({ config: { ...SCHEDULER_DEFAULTS, concurrency: 0 } });
      for (const id of ["u-admin", "u-own", "u-peer", "u-b"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of ["ws-a", "ws-b"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [ws, userId] of [
        ["ws-a", "u-own"],
        ["ws-a", "u-peer"],
        ["ws-b", "u-b"],
      ]) {
        await db.workspaceMember.create({
          data: { workspaceId: ws!, userId: userId!, role: "owner" },
        });
      }
      for (const [id, ws, createdById, autopilotEnabled] of [
        [PA, "ws-a", "u-own", true],
        [PA_OFF, "ws-a", "u-own", false],
        [PB, "ws-b", "u-b", false],
        [PB_ON, "ws-b", "u-b", true],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById, workspaceId: ws, autopilotEnabled },
        });
      }

      ADMIN = token("u-admin", "admin", []);
      OWN = token("u-own", "coordinator", ["ws-a"]);
      PEER = token("u-peer", "coordinator", ["ws-a"]);
      B = token("u-b", "coordinator", ["ws-b"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      setMCPRegistry(null);
      await scheduler?.shutdown();
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // ── 1. user-scope MCP servers ───────────────────────────────────────────
    describe("1. user-scope MCP servers are owner-only", () => {
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
          name: "POST /:id/rebind-secrets",
          method: "post",
          path: (id) => `/api/mcp/${id}/rebind-secrets`,
        },
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
        it("another user — same workspace or not — gets the unknown-id 404 and the row is unchanged", async () => {
          for (const who of [PEER, B]) {
            const id = await makeServer("user", { userId: "u-own" });
            const before = await rowOf(id);
            const res = await call(method, path(id), who, body);
            expect(res.status, JSON.stringify(res.body)).toBe(404);
            const unknown = await call(method, path("mcp-340-does-not-exist"), who, body);
            expect(unknown.status).toBe(404);
            expect(res.text).toBe(unknown.text);
            expect(await rowOf(id)).toEqual(before);
          }
        });

        it("the owner and a system admin are not refused", async () => {
          for (const who of [OWN, ADMIN]) {
            const id = await makeServer("user", { userId: "u-own" });
            const res = await call(method, path(id), who, body);
            expect(res.status, `${res.status} ${JSON.stringify(res.body)}`).not.toBe(404);
            expect(res.status).toBeLessThan(500);
          }
        });
      });

      it("a user server with no owner on record is unreachable to every non-admin (fail closed)", async () => {
        const id = await makeServer("user", { userId: null });
        for (const who of [OWN, PEER, B]) {
          expect((await call("get", `/api/mcp/${id}`, who)).status).toBe(404);
        }
        expect((await call("get", `/api/mcp/${id}`, ADMIN)).status).toBe(200);
      });

      it("global and project servers keep their existing rules", async () => {
        const glob = await makeServer("global");
        const inA = await makeServer("project", { projectId: PA });
        expect((await call("get", `/api/mcp/${glob}`, B)).status).toBe(200);
        expect((await call("get", `/api/mcp/${inA}`, PEER)).status).toBe(200);
        expect((await call("get", `/api/mcp/${inA}`, B)).status).toBe(404);
      });

      it("a server registered through the API (flag on inside this test only) is refused to another user", async () => {
        vi.stubEnv("MCP_ALLOW_USER_SCOPE", "true");
        try {
          const created = await call("post", "/api/mcp", PEER, {
            label: "peer-personal-340",
            transport: "http",
            url: "https://example.test/mcp",
            scope: "user",
          });
          expect(created.status, JSON.stringify(created.body)).toBe(201);
          const id = created.body.data.id as string;
          expect((await rowOf(id))?.userId).toBe("u-peer");
          expect((await call("get", `/api/mcp/${id}`, PEER)).status).toBe(200);
          expect((await call("delete", `/api/mcp/${id}`, OWN)).status).toBe(404);
          expect((await rowOf(id))?.deletedAt).toBeNull();
        } finally {
          vi.unstubAllEnvs();
        }
      });

      it("the registry's runtime config carries the owner, so the tool bridge can check it", async () => {
        const id = await makeServer("user", { userId: "u-own" });
        const row = await db.mCPServer.findUniqueOrThrow({ where: { id } });
        expect(registry.toConfig(row)).toMatchObject({ scope: "user", userId: "u-own" });
      });

      describe("unfiltered lists", () => {
        let mine = "";
        let theirs = "";
        let orphan = "";
        let glob = "";
        let inA = "";
        beforeAll(async () => {
          mine = await makeServer("user", { userId: "u-own" });
          theirs = await makeServer("user", { userId: "u-b" });
          orphan = await makeServer("user", { userId: null });
          glob = await makeServer("global");
          inA = await makeServer("project", { projectId: PA });
        });
        const idsOf = (res: request.Response) =>
          (res.body.data.items as Array<{ id: string }>).map((s) => s.id);

        it("GET /api/mcp shows a non-admin only their own user servers; globals and project rules unchanged", async () => {
          const own = idsOf(await call("get", "/api/mcp", OWN));
          expect(own).toEqual(expect.arrayContaining([mine, glob, inA]));
          expect(own).not.toContain(theirs);
          expect(own).not.toContain(orphan);
          const peer = idsOf(await call("get", "/api/mcp", PEER));
          expect(peer).toEqual(expect.arrayContaining([glob, inA]));
          expect(peer).not.toContain(mine);
          expect(peer).not.toContain(theirs);
          const b = idsOf(await call("get", "/api/mcp", B));
          expect(b).toEqual(expect.arrayContaining([theirs, glob]));
          expect(b).not.toContain(mine);
          expect(b).not.toContain(inA);
          const admin = idsOf(await call("get", "/api/mcp", ADMIN));
          expect(admin).toEqual(expect.arrayContaining([mine, theirs, orphan, glob, inA]));
        });

        it("GET /api/mcp?scope=user narrows the same way", async () => {
          const peer = idsOf(await call("get", "/api/mcp?scope=user", PEER));
          expect(peer).not.toContain(mine);
          expect(peer).not.toContain(theirs);
          const own = idsOf(await call("get", "/api/mcp?scope=user", OWN));
          expect(own).toContain(mine);
          expect(own).not.toContain(glob);
        });

        it("GET /api/mcp/export omits other users' user servers", async () => {
          const labelOf = async (id: string) => (await rowOf(id))!.label;
          const own = await call("get", "/api/mcp/export", OWN);
          expect(own.status).toBe(200);
          expect(own.text).toContain(await labelOf(mine));
          expect(own.text).not.toContain(await labelOf(theirs));
          expect(own.text).toContain(await labelOf(glob));
          const peer = await call("get", "/api/mcp/export", PEER);
          expect(peer.text).not.toContain(await labelOf(mine));
          const admin = await call("get", "/api/mcp/export", ADMIN);
          expect(admin.text).toContain(await labelOf(mine));
          expect(admin.text).toContain(await labelOf(theirs));
        });
      });
    });

    // ── 2. /api/runs/:id* ───────────────────────────────────────────────────
    describe("2. /api/runs/:id* answers an unreachable run with the unknown-id 404", () => {
      beforeAll(async () => {
        await db.agentRun.create({
          data: { id: "run-a-0340", sessionId: "s-340", projectId: PA, kind: "analysis" },
        });
        await db.agentRun.create({
          data: { id: "run-sys-0340", sessionId: "s-340", projectId: null, kind: "analysis" },
        });
      });

      it.each([
        ["GET /:id", (id: string) => `/api/runs/${id}`],
        ["GET /:id/replay", (id: string) => `/api/runs/${id}/replay`],
        ["GET /:id/sandbox-sessions", (id: string) => `/api/runs/${id}/sandbox-sessions`],
      ])(
        "%s: a foreign run and a system run are byte-identical to an unknown id",
        async (_n, path) => {
          const unknown = await call("get", path("run-does-not-exist-0340"), B);
          expect(unknown.status).toBe(404);
          expect(unknown.body.error.code).toBe("RUN_NOT_FOUND");
          for (const id of ["run-a-0340", "run-sys-0340"]) {
            const res = await call("get", path(id), B);
            expect(res.status).toBe(404);
            expect(res.text).toBe(unknown.text);
          }
        },
      );

      it("the project's creator and a system admin still read the run", async () => {
        for (const who of [OWN, ADMIN]) {
          const res = await call("get", "/api/runs/run-a-0340", who);
          expect(res.status, JSON.stringify(res.body)).toBe(200);
          expect(res.body.data.run.id).toBe("run-a-0340");
        }
      });
    });

    // ── 3. triggers by id ───────────────────────────────────────────────────
    describe("3. PATCH/DELETE /api/projects/:projectId/triggers/:id scope by the path's project", () => {
      let n = 0;
      const makeTrigger = async (projectId: string) => {
        n += 1;
        const row = await db.trigger.create({
          data: {
            id: `trg-340-${n}`,
            projectId,
            name: `t-${n}`,
            source: "webhook",
            config: JSON.stringify({ secret: "s3cret" }),
          },
        });
        return row.id;
      };
      const trigOf = (id: string) => db.trigger.findUnique({ where: { id } });

      it.each([
        ["PATCH", "patch" as Method, { name: "renamed", enabled: false }],
        ["DELETE", "delete" as Method, undefined],
      ])(
        "%s through another project's path: unknown-id 404, row unchanged",
        async (_n, method, body) => {
          const id = await makeTrigger(PA);
          const before = await trigOf(id);
          const res = await call(method, `/api/projects/${PB}/triggers/${id}`, ADMIN, body);
          expect(res.status, JSON.stringify(res.body)).toBe(404);
          const unknown = await call(
            method,
            `/api/projects/${PB}/triggers/trg-340-does-not-exist`,
            ADMIN,
            body,
          );
          expect(unknown.status).toBe(404);
          expect(res.text).toBe(unknown.text);
          expect(await trigOf(id)).toEqual(before);
        },
      );

      it("PATCH and DELETE through the trigger's own project still work", async () => {
        const id = await makeTrigger(PA);
        const patched = await call("patch", `/api/projects/${PA}/triggers/${id}`, ADMIN, {
          name: "renamed",
        });
        expect(patched.status, JSON.stringify(patched.body)).toBe(200);
        expect((await trigOf(id))?.name).toBe("renamed");
        // #347 — the omitted fields were not written.
        expect(JSON.parse((await trigOf(id))!.config)).toEqual({ secret: "s3cret" });
        const deleted = await call("delete", `/api/projects/${PA}/triggers/${id}`, ADMIN);
        expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
        expect(await trigOf(id)).toBeNull();
      });
    });

    // ── 4. POST /api/scheduler autopilot oracle ─────────────────────────────
    describe("4. POST /api/scheduler checks project access before the autopilot lookup", () => {
      const job = (projectId: string, key = "autopilot-340") => ({
        key,
        name: "autopilot",
        cron: "0 3 * * *",
        taskType: "rerun-analysis",
        payload: { autopilot: true },
        projectId,
      });

      it("a cross-workspace coordinator gets one identical 404 for autopilot-on, autopilot-off and nonexistent projects", async () => {
        const before = await db.scheduledJob.count();
        const on = await call("post", "/api/scheduler", B, job(PA));
        const off = await call("post", "/api/scheduler", B, job(PA_OFF));
        const none = await call("post", "/api/scheduler", B, job(NO_PROJECT));
        expect(none.status, JSON.stringify(none.body)).toBe(404);
        expect(on.status, JSON.stringify(on.body)).toBe(404);
        expect(off.status, JSON.stringify(off.body)).toBe(404);
        expect(on.text).toBe(none.text);
        expect(off.text).toBe(none.text);
        expect(await db.scheduledJob.count()).toBe(before);
      });

      it("a same-workspace coordinator who cannot schedule there gets the same 404 (createJob's own rule, hoisted)", async () => {
        const before = await db.scheduledJob.count();
        const none = await call("post", "/api/scheduler", PEER, job(NO_PROJECT, "autopilot-340-p"));
        const on = await call("post", "/api/scheduler", PEER, job(PA, "autopilot-340-p"));
        const off = await call("post", "/api/scheduler", PEER, job(PA_OFF, "autopilot-340-p"));
        expect(none.status, JSON.stringify(none.body)).toBe(404);
        expect(on.text).toBe(none.text);
        expect(off.text).toBe(none.text);
        expect(await db.scheduledJob.count()).toBe(before);
      });

      it("the caller's own project: the autopilot check still runs, and an enabled project is scheduled", async () => {
        const off = await call("post", "/api/scheduler", B, job(PB, "autopilot-340-off"));
        expect(off.status, JSON.stringify(off.body)).toBe(400);
        expect(off.body.error.code).toBe("AUTOPILOT_DISABLED");
        const on = await call("post", "/api/scheduler", B, job(PB_ON, "autopilot-340-on"));
        expect(on.status, JSON.stringify(on.body)).toBe(201);
        expect(on.body.data.projectId).toBe(PB_ON);
      });

      it("a system admin bypasses the project check", async () => {
        const off = await call(
          "post",
          "/api/scheduler",
          ADMIN,
          job(PA_OFF, "autopilot-340-adm-off"),
        );
        expect(off.body.error?.code).toBe("AUTOPILOT_DISABLED");
        const on = await call("post", "/api/scheduler", ADMIN, job(PA, "autopilot-340-adm-on"));
        expect(on.status, JSON.stringify(on.body)).toBe(201);
      });
    });

    // ── 5. GET /api/ai/tools (review round 2) ───────────────────────────────
    describe("5. GET /api/ai/tools lists a user server's tools only to its owner and admins", () => {
      let bridge: InstanceType<typeof MCPToolBridge> | null = null;
      // #351 — a user server's tool names carry its owner (`u.<ownerId>.`).
      const tool = (label: string) => `mcp:${label}:echo`;
      const labels = { mine: "", theirs: "", orphan: "", glob: "", inA: "" };
      const owners: Record<keyof typeof labels, string> = {
        mine: "u.u-own.",
        theirs: "u.u-b.",
        orphan: "u._.",
        glob: "",
        inA: "",
      };

      beforeAll(async () => {
        // The real bridge over a real lifecycle: each server row is turned into
        // its runtime config by the registry and started against an in-memory
        // transport, so the tools land in the registry exactly as in production.
        __resetToolRegistrySingleton();
        const lifecycle = new MCPLifecycleManager({
          resolveEnv: async (e) => e,
          transportFactory: () => ({
            start: async () => undefined,
            stop: async () => undefined,
            notify: async () => undefined,
            closed: () => new Promise<{ code: number | null; reason: string }>(() => undefined),
            // The stub answers each JSON-RPC method with its own payload; `TResult` is the caller's.
            request: (async (m: string) => {
              if (m === "initialize") return { protocolVersion: "2025-06-18" };
              if (m === "tools/list") return { tools: [{ name: "echo", description: "echo" }] };
              throw new Error(`unexpected ${m}`);
            }) as MCPTransportClient["request"],
          }),
        });
        bridge = new MCPToolBridge(lifecycle, registry);
        bridge.attach();
        const ids = {
          mine: await makeServer("user", { userId: "u-own" }),
          theirs: await makeServer("user", { userId: "u-b" }),
          orphan: await makeServer("user", { userId: null }),
          glob: await makeServer("global"),
          inA: await makeServer("project", { projectId: PA }),
        };
        for (const [k, id] of Object.entries(ids) as Array<[keyof typeof ids, string]>) {
          const row = await db.mCPServer.findUniqueOrThrow({ where: { id } });
          labels[k] = `${owners[k]}${row.label}`;
          // `command` only satisfies the native runtime's config check; the
          // injected transport factory above is what actually answers.
          const st = await lifecycle.start({ ...registry.toConfig(row), command: "in-memory" });
          expect(st.status, st.lastError ?? "").toBe("ready");
        }
      });
      afterAll(() => {
        bridge?.shutdown();
        __resetToolRegistrySingleton();
      });

      const names = async (who: string) => {
        const res = await call("get", "/api/ai/tools", who);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return (res.body.data.tools as Array<{ name: string }>).map((t) => t.name);
      };

      it("a non-owner — same workspace or not — never sees another user's server tools", async () => {
        const peer = await names(PEER);
        expect(peer).not.toContain(tool(labels.mine));
        expect(peer).not.toContain(tool(labels.theirs));
        expect(peer).not.toContain(tool(labels.orphan));
        const b = await names(B);
        expect(b).not.toContain(tool(labels.mine));
        expect(b).toContain(tool(labels.theirs));
      });

      it("the owner sees their own; a system admin sees every user server's tools", async () => {
        const own = await names(OWN);
        expect(own).toContain(tool(labels.mine));
        expect(own).not.toContain(tool(labels.theirs));
        const admin = await names(ADMIN);
        for (const k of ["mine", "theirs", "orphan"] as const) {
          expect(admin).toContain(tool(labels[k]));
        }
      });

      it("global and project server tools are listed to everyone, unchanged", async () => {
        for (const who of [OWN, PEER, B, ADMIN]) {
          const listed = await names(who);
          expect(listed).toContain(tool(labels.glob));
          expect(listed).toContain(tool(labels.inA));
        }
      });

      it("keeps the descriptor shape — no origin (server id, owner) in the response", async () => {
        const res = await call("get", "/api/ai/tools", ADMIN);
        for (const t of res.body.data.tools as Array<Record<string, unknown>>) {
          expect(Object.keys(t).sort()).toEqual(["description", "name", "risk"]);
        }
      });
    });
  },
);
