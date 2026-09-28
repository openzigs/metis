/**
 * #145 — the one agent definition, through the REAL `/api/custom-agents`
 * router against a REAL SQLite database built from the migration chain.
 *
 *   • Older export files still import. METIS's first public release's wizard
 *     offered tool names no tool carries (`knowledge_search`, `web_search`, …)
 *     and its built-ins named `search_documents`; an agent exported then names
 *     them. Since #238 a SAVE refuses unknown tools, which made every such file
 *     un-importable (400). An import now drops the names this install does not
 *     have and reports them (`meta.droppedTools`). A dropped name never granted
 *     anything — the allowlist is matched exactly — so the imported agent can
 *     call exactly what it could before; nothing is ever mapped or widened.
 *   • The edit form's PATCH (its first consumer): every definition field reads
 *     back through the production loader, the version bumps, and the project
 *     scope holds (foreign caller 404, wrong role 403, system admin bypass).
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { ToolDefinition } from "../src/lib/ai/types.js";

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

const { customAgentsRouter } = await import("../src/routes/custom-agents.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { loadAgentDefinition } = await import("../src/lib/agent-runtime/definition.js");
const { getToolRegistry, __resetToolRegistrySingleton } =
  await import("../src/lib/ai/tool-registry.js");

type Role = "admin" | "coordinator" | "developer" | "reader";

/** An export document exactly as the first public release's wizard produced it. */
const LEGACY_WIZARD_EXPORT = {
  schemaVersion: 1,
  agent: {
    name: "Risk Reviewer",
    description: "Surfaces delivery risks.",
    systemPrompt: "You are a pragmatic risk reviewer.",
    tools: ["knowledge_search", "count_rows", "web_search"],
    model: null,
    reasoningEffort: "medium",
  },
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#145 — custom agents: older exports import, the edit form's PATCH (real router, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const token = (userId: string, role: Role, workspaces: string[]) =>
      issueTokens({ userId, username: userId, role, permissions: [], workspaces }).accessToken;
    let ADMIN = "";
    let OWNER_A = "";
    let MEMBER_A = "";
    let OWNER_B = "";

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/custom-agents", customAgentsRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    const call = (
      method: "get" | "post" | "patch",
      url: string,
      bearer: string,
      body?: Record<string, unknown>,
    ) => {
      const r = request(app())[method](url).set("Authorization", `Bearer ${bearer}`);
      return body ? r.send(body) : r;
    };

    beforeAll(async () => {
      sqlite = createMigratedSqlite("145-custom-agent-definition");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      __resetToolRegistrySingleton();
      getToolRegistry().register({
        name: "count_rows",
        description: "c",
        schema: z.object({}),
        risk: "low",
        exec: async () => ({ text: "" }),
      } as ToolDefinition);

      for (const id of ["u-admin", "u-a", "u-member-a", "u-b"]) {
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
        data: { workspaceId: "ws-a", userId: "u-member-a", role: "member" },
      });
      await db.workspaceMember.create({
        data: { workspaceId: "ws-b", userId: "u-b", role: "owner" },
      });
      for (const [id, ws] of [
        ["proj-a", "ws-a"],
        ["proj-b", "ws-b"],
      ]) {
        await db.project.create({
          data: { id, name: id, slug: id, createdById: "u-admin", workspaceId: ws },
        });
      }
      // A configured (stopped) MCP server of proj-a: a ref to it is KNOWN.
      await db.mCPServer.create({
        data: {
          id: "mcp-pa",
          scope: "project",
          projectId: "proj-a",
          label: "pa",
          transport: "http",
          url: "https://mcp.example.test",
        },
      });
      await db.skill.create({ data: { id: "sk-1", key: "style-guide", name: "Style" } });
      await db.customAgent.create({
        data: {
          id: "ca-edit",
          projectId: "proj-a",
          name: "Editable",
          description: "before",
          systemPrompt: "You were written before the edit.",
          tools: JSON.stringify(["count_rows"]),
        },
      });
      await db.customAgent.create({
        data: { id: "ca-b", projectId: "proj-b", name: "Other", systemPrompt: "b" },
      });

      ADMIN = token("u-admin", "admin", []);
      OWNER_A = token("u-a", "coordinator", ["ws-a"]);
      MEMBER_A = token("u-member-a", "developer", ["ws-a"]);
      OWNER_B = token("u-b", "coordinator", ["ws-b"]);
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    describe("POST /api/custom-agents/import — older export files", () => {
      it("imports a first-release wizard export: unknown tool names are dropped and reported, known ones kept", async () => {
        const res = await call("post", "/api/custom-agents/import", OWNER_A, {
          projectId: "proj-a",
          document: LEGACY_WIZARD_EXPORT,
        });
        expect(res.status).toBe(201);
        expect(res.body.data.tools).toEqual(["count_rows"]);
        expect(res.body.meta.droppedTools).toEqual(["knowledge_search", "web_search"]);

        // Read back through the production paths, not the response.
        const got = await call("get", `/api/custom-agents/${res.body.data.id}`, OWNER_A);
        expect(got.status).toBe(200);
        expect(got.body.data).toMatchObject({
          name: "Risk Reviewer",
          description: "Surfaces delivery risks.",
          systemPrompt: "You are a pragmatic risk reviewer.",
          tools: ["count_rows"],
          reasoningEffort: "medium",
          projectId: "proj-a",
        });
        const def = await loadAgentDefinition(`custom:${res.body.data.id}`, db);
        expect(def?.toolAllowlist).toEqual(["count_rows"]);
      });

      it("never widens: an agent that named only unknown tools imports with NO tools (exactly what it could call before)", async () => {
        const res = await call("post", "/api/custom-agents/import", OWNER_A, {
          projectId: "proj-a",
          document: {
            schemaVersion: 1,
            agent: {
              name: "Old Builtin Copy",
              systemPrompt: "x",
              tools: ["search_documents", "record_project_memory", "mcp:nowhere:*"],
            },
          },
        });
        expect(res.status).toBe(201);
        expect(res.body.meta.droppedTools).toEqual([
          "search_documents",
          "record_project_memory",
          "mcp:nowhere:*",
        ]);
        const def = await loadAgentDefinition(`custom:${res.body.data.id}`, db);
        // Custom agents: an empty list is an allowlist of NOTHING, never "all".
        expect(def?.toolAllowlist).toEqual([]);
      });

      it("keeps a ref to an MCP server configured for the project (only unknown names drop)", async () => {
        const res = await call("post", "/api/custom-agents/import", OWNER_A, {
          projectId: "proj-a",
          document: {
            schemaVersion: 2,
            agent: {
              name: "Mcp User",
              systemPrompt: "x",
              tools: ["mcp:pa:*", "count_rows"],
              skillKeys: ["style-guide"],
              approvalPolicy: { high: "deny" },
            },
          },
        });
        expect(res.status).toBe(201);
        expect(res.body.meta.droppedTools).toEqual([]);
        const def = await loadAgentDefinition(`custom:${res.body.data.id}`, db);
        expect(def).toMatchObject({
          toolAllowlist: ["mcp:pa:*", "count_rows"],
          skillKeys: ["style-guide"],
          approvalPolicy: { high: "deny" },
        });
      });

      it("a caller outside the project's workspace gets 404 and nothing is created; a system admin may import", async () => {
        const before = await db.customAgent.count();
        const denied = await call("post", "/api/custom-agents/import", OWNER_B, {
          projectId: "proj-a",
          document: {
            ...LEGACY_WIZARD_EXPORT,
            agent: { ...LEGACY_WIZARD_EXPORT.agent, name: "Nope" },
          },
        });
        expect(denied.status).toBe(404);
        expect(await db.customAgent.count()).toBe(before);

        const admin = await call("post", "/api/custom-agents/import", ADMIN, {
          projectId: "proj-a",
          document: {
            ...LEGACY_WIZARD_EXPORT,
            agent: { ...LEGACY_WIZARD_EXPORT.agent, name: "By Admin" },
          },
        });
        expect(admin.status).toBe(201);
        expect(admin.body.data.tools).toEqual(["count_rows"]);
      });
    });

    describe("PATCH /api/custom-agents/:id — the edit form's payload", () => {
      it("saves every definition field, bumps the version, and the runtime loader reads it back", async () => {
        const res = await call("patch", "/api/custom-agents/ca-edit", OWNER_A, {
          description: "after",
          systemPrompt: "You are the edited persona.",
          tools: ["count_rows", "agent:*"],
          model: "some-model",
          reasoningEffort: "high",
          skillKeys: ["style-guide"],
          approvalPolicy: { low: "prompt-once", high: "deny" },
        });
        expect(res.status).toBe(200);
        expect(res.body.data.version).toBe("1.0.1");

        const def = await loadAgentDefinition("custom:ca-edit", db);
        expect(def).toMatchObject({
          description: "after",
          persona: "You are the edited persona.",
          toolAllowlist: ["count_rows", "agent:*"],
          model: "some-model",
          reasoningEffort: "high",
          skillKeys: ["style-guide"],
          approvalPolicy: { low: "prompt-once", high: "deny" },
          version: "1.0.1",
          projectId: "proj-a",
        });
      });

      it("null clears the model, the reasoning effort and the approval override", async () => {
        const res = await call("patch", "/api/custom-agents/ca-edit", OWNER_A, {
          model: null,
          reasoningEffort: null,
          approvalPolicy: null,
        });
        expect(res.status).toBe(200);
        const def = await loadAgentDefinition("custom:ca-edit", db);
        expect(def).toMatchObject({ model: null, reasoningEffort: null, approvalPolicy: null });
        expect(def?.version).toBe("1.0.2");
      });

      it("refuses a tool this install does not have (authoring stays strict)", async () => {
        const before = await loadAgentDefinition("custom:ca-edit", db);
        const res = await call("patch", "/api/custom-agents/ca-edit", OWNER_A, {
          tools: ["knowledge_search"],
        });
        expect(res.status).toBe(400);
        expect(res.body.error.message).toContain("knowledge_search");
        const after = await loadAgentDefinition("custom:ca-edit", db);
        expect(after?.toolAllowlist).toEqual(before?.toolAllowlist);
        expect(after?.version).toBe(before?.version);
      });

      it("another workspace's owner gets 404, a plain member 403, and the row is unchanged; a system admin may edit", async () => {
        const foreign = await call("patch", "/api/custom-agents/ca-edit", OWNER_B, {
          systemPrompt: "hijacked",
        });
        expect(foreign.status).toBe(404);
        const member = await call("patch", "/api/custom-agents/ca-edit", MEMBER_A, {
          systemPrompt: "hijacked",
        });
        expect(member.status).toBe(403);
        expect((await loadAgentDefinition("custom:ca-edit", db))?.persona).toBe(
          "You are the edited persona.",
        );

        const admin = await call("patch", "/api/custom-agents/ca-b", ADMIN, {
          description: "admin edit",
        });
        expect(admin.status).toBe(200);
        expect((await loadAgentDefinition("custom:ca-b", db))?.description).toBe("admin edit");
      });
    });
  },
);
