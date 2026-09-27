/**
 * #238 — an agent may name the tools of a CONFIGURED MCP server that is not
 * running. The save-time check used to read only the live `ToolRegistry`, which
 * holds a server's tools only while it runs, so saving an agent that named
 * `mcp:<server>:<tool>` or `mcp:<server>:*` of a stopped server was a 400, and a
 * plugin import dropped that agent without a word.
 *
 * Now a ref counts when `<server>` is configured for the agent's project (its
 * own servers and the global servers on its allow-list) — read from MCP config
 * in a real SQLite database. An unknown server, an unknown built-in, or a tool
 * a RUNNING server does not have are still refused; and a plugin import reports
 * every agent it could not create. Run-time matching (exact names) is untouched.
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import type { ToolDefinition } from "../src/lib/ai/types.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
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

const { createAgent, updateAgent } = await import("../src/lib/custom-agents/index.js");
const { mcpLabelSlug } = await import("../src/lib/agent-runtime/tool-refs.js");
const { formatToolName } = await import("../src/lib/mcp/tool-bridge.js");
const { __resetToolRegistrySingleton, getToolRegistry } =
  await import("../src/lib/ai/tool-registry.js");
const { pluginsRouter } = await import("../src/routes/plugins.js");
const { pack } = await import("../src/lib/plugins/index.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");

describe("#238 mcpLabelSlug is the slug the MCP bridge names tools with", () => {
  for (const label of ["GitHub", "My Jira (prod)", "  --x--  ", "a".repeat(50), "db_2"]) {
    it(JSON.stringify(label), () => {
      expect(formatToolName(label, "t")).toBe(`mcp:${mcpLabelSlug(label)}:t`);
    });
  }
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#238 MCP refs are checked against MCP CONFIG, not only the running servers",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("238-mcp-configured");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1", username: "u-1", displayName: "u", email: "u@example.test" },
      });
      for (const id of ["p-1", "p-2"]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: "u-1" } });
      }
      // p-1's own server (stopped), a global server on p-1's allow-list, a
      // global server NOT on it, another project's server, a deleted one.
      const server = (data: Record<string, unknown>) =>
        db.mCPServer.create({ data: { transport: "stdio", command: "x", ...data } as never });
      await server({ id: "m-own", scope: "project", projectId: "p-1", label: "Jira Local" });
      await server({ id: "m-glob", scope: "global", label: "GitHub" });
      await server({ id: "m-glob-off", scope: "global", label: "Not Allowed" });
      await server({ id: "m-other", scope: "project", projectId: "p-2", label: "Elsewhere" });
      await server({
        id: "m-gone",
        scope: "project",
        projectId: "p-1",
        label: "Gone",
        deletedAt: new Date(),
      });
      await db.projectMCPAllowlist.create({ data: { projectId: "p-1", mcpServerId: "m-glob" } });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    beforeEach(() => {
      __resetToolRegistrySingleton();
      getToolRegistry().register({
        name: "count_rows",
        description: "Count rows",
        schema: z.object({}),
        risk: "low",
        exec: async () => ({ text: "" }),
      } as ToolDefinition);
    });

    let n = 0;
    const save = (tools: string[], projectId = "p-1") =>
      createAgent({ projectId, name: `a-${++n}`, systemPrompt: "x", tools }, "u-1");

    it("accepts a stopped, configured server's tools by name and by server wildcard", async () => {
      const a = await save([
        "count_rows",
        "mcp:jira-local:create_issue",
        "mcp:jira-local:*",
        "mcp:github:get_file",
        "mcp:github:*",
      ]);
      expect(a.tools).toContain("mcp:jira-local:create_issue");
    });

    const refused: Array<[string, string]> = [
      ["a server that is not configured at all", "mcp:nope:tool"],
      ["a server wildcard that is not configured", "mcp:nope:*"],
      ["a global server NOT on the project's allow-list", "mcp:not-allowed:tool"],
      ["another project's server", "mcp:elsewhere:*"],
      ["a deleted server", "mcp:gone:tool"],
      ["an unknown built-in", "search_documents"],
      ["an empty tool part", "mcp:github:"],
    ];
    for (const [name, ref] of refused) {
      it(`still refuses ${name} (${ref}), and writes nothing`, async () => {
        const before = await db.customAgent.count();
        await expect(save(["count_rows", ref])).rejects.toThrow(`Unknown tools: ${ref}`);
        expect(await db.customAgent.count()).toBe(before);
      });
    }

    it("while a configured server IS running, a tool it does not have is still refused", async () => {
      getToolRegistry().register({
        name: "mcp:github:get_file",
        description: "live",
        schema: z.object({}),
        risk: "low",
        exec: async () => ({ text: "" }),
      } as ToolDefinition);
      await expect(save(["mcp:github:get_file", "mcp:github:*"])).resolves.toBeTruthy();
      await expect(save(["mcp:github:typo_tool"])).rejects.toThrow(
        "Unknown tools: mcp:github:typo_tool",
      );
    });

    it("update applies the same rule, against the agent's own project", async () => {
      const a = await save(["count_rows"]);
      const b = await updateAgent(a.id, { tools: ["mcp:jira-local:*"] }, "u-1");
      expect(b.tools).toEqual(["mcp:jira-local:*"]);
      const other = await save(["count_rows"], "p-2");
      await expect(updateAgent(other.id, { tools: ["mcp:jira-local:*"] }, "u-1")).rejects.toThrow(
        "Unknown tools: mcp:jira-local:*",
      );
    });

    describe("plugin import", () => {
      const app = () => {
        const a = express();
        a.use(express.json({ limit: "2mb" }));
        a.use("/api/plugins", pluginsRouter());
        a.use(notFoundHandler);
        a.use(errorHandler);
        return a;
      };
      const admin = issueTokens({
        userId: "u-1",
        username: "u-1",
        role: "admin",
        permissions: [],
      }).accessToken;

      it("creates an agent naming a stopped configured server, and REPORTS the ones it rejects", async () => {
        const envelope = JSON.parse(
          pack({
            manifest: { name: "demo", version: "1.0.0", description: "" },
            skills: [],
            agents: [
              {
                name: "Uses stopped Jira",
                description: "",
                systemPrompt: "x",
                tools: ["mcp:jira-local:*"],
              },
              { name: "Names nonsense", description: "", systemPrompt: "x", tools: ["nope"] },
            ],
            hooks: [],
            exportedAt: "2026-09-27T00:00:00.000Z",
          }).toString("utf8"),
        );
        const res = await request(app())
          .post("/api/plugins/import")
          .set("Authorization", `Bearer ${admin}`)
          .send({ projectId: "p-1", envelope });
        expect(res.status, res.text).toBe(201);
        expect(res.body.data.installed.agents).toBe(1);
        expect(res.body.data.rejected.agents).toEqual([
          { name: "Names nonsense", reason: "Unknown tools: nope" },
        ]);
        expect(
          await db.customAgent.findFirst({
            where: { projectId: "p-1", name: "Uses stopped Jira" },
          }),
        ).not.toBeNull();
        expect(
          await db.customAgent.findFirst({ where: { projectId: "p-1", name: "Names nonsense" } }),
        ).toBeNull();
      });
    });
  },
);
