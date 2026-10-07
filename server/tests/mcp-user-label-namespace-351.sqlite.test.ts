/**
 * #351 — a `scope: "user"` MCP server's label is its owner's own, proven
 * through the REAL `/api/mcp` router, the REAL registry service and the REAL
 * tool bridge against a REAL SQLite database built from the migration chain.
 *
 *   1. Creating a user server whose label ANOTHER user already holds succeeds
 *      (it used to answer `409 LABEL_TAKEN`, echoing the label back — an
 *      oracle confirming that the other user's server exists). The same user
 *      re-using their own label is still refused.
 *   2. A user server's tools are named with an owner-qualified server segment
 *      (`mcp:u.<ownerId>.<slug>:<tool>`), so two users' same-label servers and
 *      a global server of that label all register side by side — none of the
 *      three silently fails to register, and the global tool stays known to
 *      agent allowlists.
 *
 * Two real users (`u-alice`, `u-bob`) in separate workspaces, both
 * coordinators, so every outcome below is the label rule, never the role check.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MCPTransportClient } from "../src/lib/mcp/types.js";
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
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { setMCPRegistry, MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
const { MCPToolBridge } = await import("../src/lib/mcp/tool-bridge.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { knownToolNames } = await import("../src/lib/agent-runtime/tool-refs.js");

const LABEL = "shared-351";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#351 — user-scope MCP labels are per-owner, and their tool names never collide",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let registry: InstanceType<typeof MCPRegistryService>;
    let lifecycle: InstanceType<typeof MCPLifecycleManager>;
    let bridge: InstanceType<typeof MCPToolBridge>;

    const token = (userId: string, workspaces: string[]) =>
      issueTokens({
        userId,
        username: userId,
        role: "coordinator",
        permissions: [],
        workspaces,
      }).accessToken;
    let ALICE = "";
    let BOB = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/mcp", mcpRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const createUserServer = (bearer: string, label: string) =>
      request(app())
        .post("/api/mcp")
        .set("Authorization", `Bearer ${bearer}`)
        .send({ label, transport: "http", url: "https://example.test/mcp", scope: "user" });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("351-user-label-namespace");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetToolRegistrySingleton();
      lifecycle = new MCPLifecycleManager({
        resolveEnv: async (e) => e,
        transportFactory: () => ({
          start: async () => undefined,
          stop: async () => undefined,
          notify: async () => undefined,
          closed: () => new Promise(() => undefined),
          // request<TResult> is generic; a canned-response stub cannot satisfy it without an assertion.
          request: (async (m: string) => {
            if (m === "initialize") return { protocolVersion: "2025-06-18" };
            if (m === "tools/list") return { tools: [{ name: "echo", description: "echo" }] };
            throw new Error(`unexpected ${m}`);
          }) as MCPTransportClient["request"],
        }),
      });
      registry = new MCPRegistryService(lifecycle);
      setMCPRegistry(registry);
      bridge = new MCPToolBridge(lifecycle, registry);
      bridge.attach();
      for (const [id, ws] of [
        ["u-alice", "ws-alice"],
        ["u-bob", "ws-bob"],
      ] as const) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
        await db.workspaceMember.create({ data: { workspaceId: ws, userId: id, role: "owner" } });
      }
      ALICE = token("u-alice", ["ws-alice"]);
      BOB = token("u-bob", ["ws-bob"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    afterAll(async () => {
      bridge?.shutdown();
      __resetToolRegistrySingleton();
      setMCPRegistry(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("1. creating a user server with a label another user holds", () => {
      it("succeeds, and never reveals that the other user's server exists", async () => {
        vi.stubEnv("MCP_ALLOW_USER_SCOPE", "true");
        const alice = await createUserServer(ALICE, "personal-351");
        expect(alice.status, JSON.stringify(alice.body)).toBe(201);
        const bob = await createUserServer(BOB, "personal-351");
        expect(bob.status, JSON.stringify(bob.body)).toBe(201);
        expect(bob.body.data.id).not.toBe(alice.body.data.id);
        expect(JSON.stringify(bob.body)).not.toContain("LABEL_TAKEN");
        expect(JSON.stringify(bob.body)).not.toContain(alice.body.data.id);
        const rows = await db.mCPServer.findMany({
          where: { scope: "user", label: "personal-351", deletedAt: null },
          orderBy: { userId: "asc" },
        });
        expect(rows.map((r) => r.userId)).toEqual(["u-alice", "u-bob"]);
      });

      it("the same user re-using their OWN label is still refused (positive control)", async () => {
        vi.stubEnv("MCP_ALLOW_USER_SCOPE", "true");
        const first = await createUserServer(ALICE, "twice-351");
        expect(first.status, JSON.stringify(first.body)).toBe(201);
        const again = await createUserServer(ALICE, "twice-351");
        expect(again.status).toBe(409);
        expect(again.body.error?.code).toBe("LABEL_TAKEN");
        expect(await db.mCPServer.count({ where: { label: "twice-351", deletedAt: null } })).toBe(
          1,
        );
      });

      it("a deleted server of the other user does not matter either way", async () => {
        vi.stubEnv("MCP_ALLOW_USER_SCOPE", "true");
        const bob = await createUserServer(BOB, "gone-351");
        expect(bob.status).toBe(201);
        await db.mCPServer.update({
          where: { id: bob.body.data.id as string },
          data: { deletedAt: new Date() },
        });
        const alice = await createUserServer(ALICE, "gone-351");
        expect(alice.status, JSON.stringify(alice.body)).toBe(201);
      });
    });

    describe("2. tool names never collide across users, or between user and global scopes", () => {
      const ids = { alice: "", bob: "", glob: "" };
      const start = async (id: string) => {
        const row = await db.mCPServer.findUniqueOrThrow({ where: { id } });
        // `command` only satisfies the native runtime's config check; the
        // injected transport factory above is what actually answers.
        const st = await lifecycle.start({ ...registry.toConfig(row), command: "in-memory" });
        expect(st.status, st.lastError ?? "").toBe("ready");
      };

      beforeAll(async () => {
        for (const [k, scope, userId] of [
          ["alice", "user", "u-alice"],
          ["bob", "user", "u-bob"],
          ["glob", "global", null],
        ] as const) {
          const row = await db.mCPServer.create({
            data: {
              id: `mcp-351-${k}`,
              scope,
              userId,
              label: LABEL,
              transport: "http",
              url: "https://example.test/mcp",
            },
          });
          ids[k] = row.id;
        }
        // Users first, so a user tool would take the plain name ahead of the global one.
        await start(ids.alice);
        await start(ids.bob);
        await start(ids.glob);
      });

      it("each of the three same-label servers registers its tool", () => {
        const alice = bridge.registeredFor(ids.alice);
        const bob = bridge.registeredFor(ids.bob);
        const glob = bridge.registeredFor(ids.glob);
        expect(alice).toEqual([`mcp:u.u-alice.${LABEL}:echo`]);
        expect(bob).toEqual([`mcp:u.u-bob.${LABEL}:echo`]);
        expect(glob).toEqual([`mcp:${LABEL}:echo`]);
        const reg = getToolRegistry();
        for (const name of [...alice, ...bob, ...glob]) expect(reg.has(name)).toBe(true);
      });

      it("the global tool stays known to agent allowlists; the user tools stay hidden", () => {
        const known = knownToolNames(getToolRegistry());
        expect(known.has(`mcp:${LABEL}:echo`)).toBe(true);
        expect(known.has(`mcp:u.u-alice.${LABEL}:echo`)).toBe(false);
        expect(known.has(`mcp:u.u-bob.${LABEL}:echo`)).toBe(false);
      });

      it("each user tool is bound to its OWN owner's server", async () => {
        const reg = getToolRegistry();
        const alicesTool = reg.describeAll().find((v) => v.name === `mcp:u.u-alice.${LABEL}:echo`);
        expect(alicesTool?.origin).toMatchObject({
          serverId: ids.alice,
          serverScope: "user",
          serverOwnerId: "u-alice",
        });
        const bobsTool = reg.describeAll().find((v) => v.name === `mcp:u.u-bob.${LABEL}:echo`);
        expect(bobsTool?.origin).toMatchObject({ serverId: ids.bob, serverOwnerId: "u-bob" });
      });
    });
  },
);
