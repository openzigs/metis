/**
 * #334 (review of PR #341) — `POST /api/plugins/export` loads custom agents
 * (system prompts) and hook subscriptions (handler config, which can carry
 * webhook headers) by ids taken from the request BODY, outside any
 * `/projects/:projectId` chokepoint. It was gated by `requireAuth` alone, so
 * any authenticated caller could export another workspace's agents and hooks.
 *
 * Proven through the REAL `pluginsRouter`, the REAL `requireAuth` and the REAL
 * `assertProjectAccess`, against a REAL SQLite database built from the
 * migration chain, with JWTs from `issueTokens`. Two workspaces: `ws-a`
 * (project `proj-a-0334p`) and `ws-b` (project `proj-b-0334p`). The attacker is
 * `u-b`, a coordinator in `ws-b` who holds `mcp.read`, so every drop below is
 * the project check, never the role check. A foreign row must be dropped
 * EXACTLY as an unknown id is, so the envelope is compared with the envelope
 * for an unknown id. Positive controls: the same-workspace coordinator `u-a`,
 * a system admin, and a built-in (`projectId: null`) agent.
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

const { pluginsRouter } = await import("../src/routes/plugins.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

type Role = "admin" | "coordinator" | "developer" | "reader";

const PA = "proj-a-0334p";
const PB = "proj-b-0334p";

interface Envelope {
  agents: Array<{ name: string; systemPrompt: string }>;
  hooks: Array<{ config: Record<string, unknown> }>;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#334 — POST /api/plugins/export checks the caller's access to each row's project",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const token = (userId: string, role: Role, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
    let ADMIN = "";
    let A = ""; // coordinator in ws-a — same-workspace positive control
    let B = ""; // coordinator in ws-b — the attacker (holds mcp.read)
    let READER_A = ""; // reader in ws-a — lacks mcp.read

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/plugins", pluginsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const exportAs = (bearer: string, ids: { customAgentIds?: string[]; hookIds?: string[] }) =>
      request(app())
        .post("/api/plugins/export")
        .set("Authorization", `Bearer ${bearer}`)
        .send({ name: "probe", version: "1.0.0", ...ids });
    const envelope = (res: { text: string }): Envelope => JSON.parse(res.text) as Envelope;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("334-plugins-export");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      for (const id of ["u-admin", "u-a", "u-b", "u-ra"]) {
        await db.user.create({
          data: { id, username: id, displayName: id, email: `${id}@example.test` },
        });
      }
      for (const ws of ["ws-a", "ws-b"]) {
        await db.workspace.create({ data: { id: ws, name: ws, slug: ws } });
      }
      for (const [ws, userId] of [
        ["ws-a", "u-a"],
        ["ws-a", "u-ra"],
        ["ws-b", "u-b"],
      ]) {
        await db.workspaceMember.create({ data: { workspaceId: ws, userId, role: "member" } });
      }
      for (const [id, ws] of [
        [PA, "ws-a"],
        [PB, "ws-b"],
      ] as const) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-admin", workspaceId: ws },
        });
      }
      await db.customAgent.create({
        data: { id: "ag-a", projectId: PA, name: "agent-a", systemPrompt: "secret prompt a" },
      });
      await db.customAgent.create({
        data: { id: "ag-b", projectId: PB, name: "agent-b", systemPrompt: "own prompt b" },
      });
      await db.customAgent.create({
        data: { id: "ag-builtin", projectId: null, name: "builtin", isBuiltIn: true },
      });
      await db.hookSubscription.create({
        data: {
          id: "hk-a",
          projectId: PA,
          event: "preToolUse",
          handlerKind: "webhook",
          config: JSON.stringify({
            url: "https://hooks.example.test/a",
            headers: { authorization: "Bearer secret-header-a" },
          }),
        },
      });
      await db.hookSubscription.create({
        data: {
          id: "hk-b",
          projectId: PB,
          event: "preToolUse",
          handlerKind: "webhook",
          config: JSON.stringify({ url: "https://hooks.example.test/b" }),
        },
      });

      ADMIN = token("u-admin", "admin", []);
      A = token("u-a", "coordinator", ["ws-a"]);
      B = token("u-b", "coordinator", ["ws-b"]);
      READER_A = token("u-ra", "reader", ["ws-a"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("a cross-workspace caller's foreign agent is dropped exactly like an unknown id", async () => {
      const res = await exportAs(B, { customAgentIds: ["ag-a"] });
      const unknown = await exportAs(B, { customAgentIds: ["ag-does-not-exist"] });
      expect(res.status).toBe(200);
      expect(unknown.status).toBe(200);
      expect(envelope(res).agents).toEqual(envelope(unknown).agents);
      expect(envelope(res).agents).toEqual([]);
      expect(res.text).not.toContain("secret prompt a");
    });

    it("a cross-workspace caller's foreign hook is dropped exactly like an unknown id", async () => {
      const res = await exportAs(B, { hookIds: ["hk-a"] });
      const unknown = await exportAs(B, { hookIds: ["hk-does-not-exist"] });
      expect(res.status).toBe(200);
      expect(envelope(res).hooks).toEqual(envelope(unknown).hooks);
      expect(envelope(res).hooks).toEqual([]);
      expect(res.text).not.toContain("secret-header-a");
    });

    it("a mixed request keeps the caller's own rows and drops only the foreign ones", async () => {
      const res = await exportAs(B, {
        customAgentIds: ["ag-a", "ag-b", "ag-builtin"],
        hookIds: ["hk-a", "hk-b"],
      });
      expect(res.status).toBe(200);
      const env = envelope(res);
      expect(env.agents.map((a) => a.name).sort()).toEqual(["agent-b", "builtin"]);
      expect(env.hooks.map((h) => h.config.url)).toEqual(["https://hooks.example.test/b"]);
    });

    it("a same-workspace coordinator exports its own agent and hook (positive control)", async () => {
      const res = await exportAs(A, { customAgentIds: ["ag-a"], hookIds: ["hk-a"] });
      expect(res.status).toBe(200);
      const env = envelope(res);
      expect(env.agents.map((a) => a.systemPrompt)).toEqual(["secret prompt a"]);
      expect(env.hooks).toHaveLength(1);
    });

    it("a system admin exports rows from every workspace (admin bypass)", async () => {
      const res = await exportAs(ADMIN, {
        customAgentIds: ["ag-a", "ag-b"],
        hookIds: ["hk-a", "hk-b"],
      });
      expect(res.status).toBe(200);
      const env = envelope(res);
      expect(env.agents).toHaveLength(2);
      expect(env.hooks).toHaveLength(2);
    });

    it("a caller without mcp.read cannot export hooks, even its own project's", async () => {
      const res = await exportAs(READER_A, { hookIds: ["hk-a"] });
      expect(res.status).toBe(403);
      expect(res.text).not.toContain("secret-header-a");
    });

    it("a caller without mcp.read can still export its own project's agents", async () => {
      const res = await exportAs(READER_A, { customAgentIds: ["ag-a"] });
      expect(res.status).toBe(200);
      expect(envelope(res).agents).toHaveLength(1);
    });
  },
);
