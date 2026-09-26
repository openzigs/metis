/**
 * Epic #129 (#145) — "existing agents of both kinds migrate without loss".
 *
 * A REAL SQLite database is built as it stood BEFORE the #129 migration, and
 * fixture rows are written in the OLD shape: library agents (with default
 * skills, a tool allowlist, a model and a version), custom agents (a built-in
 * and a project agent with tools, model and reasoning effort) and a per-project
 * enablement. Then the #129 migration is applied, exactly as a deployment would.
 *
 * Proven: every column every row had is byte-identical afterwards; the new
 * columns take their documented defaults; and BOTH kinds read back through the
 * one definition loader with every field — persona, skills, allowlist, model,
 * effort, version — intact. Reads go through the production code, never the
 * objects this test built.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import { createMigratedSqlite, type MigratedSqlite } from "./helpers/sqlite-migrated-db.js";

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

const { loadAgentDefinition, listCallableAgents } =
  await import("../src/lib/agent-runtime/definition.js");
const { listAgents, getAgent } = await import("../src/lib/custom-agents/index.js");
const { exportAgent } = await import("../src/lib/custom-agents/portability.js");

const MIGRATION = "20260927000000_issue129_unified_agents_subagents";
const NOW = "2026-09-01T00:00:00.000Z";

function snapshot(file: string, table: string): Array<Record<string, unknown>> {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#145 — agents of both kinds survive the #129 migration (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const before: Record<string, Array<Record<string, unknown>>> = {};

    beforeAll(() => {
      sqlite = createMigratedSqlite("129-migration", { stopBefore: MIGRATION });
      const x = sqlite.exec;
      x(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES ('u1','u1','U1','u1@example.test',?,?)`,
        [NOW, NOW],
      );
      x(
        `INSERT INTO projects (id, name, slug, createdById, createdAt, updatedAt) VALUES ('p1','P','p-1','u1',?,?)`,
        [NOW, NOW],
      );
      x(
        `INSERT INTO skills (id, key, name, description, version, instructions, createdAt, updatedAt)
         VALUES ('s1','style-guide','Style guide','How to write','1.2.0','Write plainly.',?,?)`,
        [NOW, NOW],
      );
      x(
        `INSERT INTO agents (id, key, name, displayName, description, model, systemPrompt, tools,
           tags, handoffs, manifest, contentSha256, source, enabled, version, createdAt, updatedAt)
         VALUES ('a1','scribe','scribe','The Scribe','Writes things','claude-sonnet-4-6',
           'You write.','["search-knowledge","mcp:github:*"]','["docs"]','[]','{"name":"scribe"}',
           'abc','inline',1,'2.3.4',?,?)`,
        [NOW, NOW],
      );
      x(`INSERT INTO agent_skills (agentId, skillId) VALUES ('a1','s1')`);
      x(
        `INSERT INTO custom_agents (id, projectId, name, description, systemPrompt, tools, model,
           reasoningEffort, isBuiltIn, createdAt, updatedAt)
         VALUES ('c-builtin',NULL,'QA','QA lead','You test.','["search_documents"]',NULL,
           'medium',1,?,?)`,
        [NOW, NOW],
      );
      x(
        `INSERT INTO custom_agents (id, projectId, name, description, systemPrompt, tools, model,
           reasoningEffort, isBuiltIn, createdAt, updatedAt)
         VALUES ('c-proj','p1','Reviewer','Reviews','You review.','["search-knowledge"]',
           'gpt-4.1','high',0,?,?)`,
        [NOW, NOW],
      );
      x(
        `INSERT INTO custom_agent_enablements (id, customAgentId, projectId, enabled, createdAt, updatedAt)
         VALUES ('e1','c-builtin','p1',1,?,?)`,
        [NOW, NOW],
      );
      x(
        `INSERT INTO project_agent_allowlists (projectId, agentId, enabled, createdAt)
         VALUES ('p1','a1',1,?)`,
        [NOW],
      );
      for (const t of ["agents", "custom_agents", "agent_skills", "custom_agent_enablements"]) {
        before[t] = snapshot(sqlite.dbFile, t);
      }
      sqlite.apply(MIGRATION);
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("keeps every column of every row it had, and defaults only the new columns", () => {
      for (const table of Object.keys(before)) {
        const after = snapshot(sqlite.dbFile, table);
        expect(after).toHaveLength(before[table]!.length);
        after.forEach((row, i) => {
          for (const [col, value] of Object.entries(before[table]![i]!)) {
            expect(row[col], `${table}.${col}`).toEqual(value);
          }
        });
      }
      const [lib] = snapshot(sqlite.dbFile, "agents");
      expect(lib).toMatchObject({ reasoningEffort: null, approvalPolicy: null });
      for (const c of snapshot(sqlite.dbFile, "custom_agents")) {
        expect(c).toMatchObject({ skillKeys: "[]", approvalPolicy: null, version: "1.0.0" });
      }
    });

    it("a LIBRARY agent reads back as the one definition with every field intact", async () => {
      expect(await loadAgentDefinition("library:a1")).toEqual({
        ref: "library:a1",
        kind: "library",
        id: "a1",
        key: "scribe",
        name: "The Scribe",
        description: "Writes things",
        persona: "You write.",
        skillKeys: ["style-guide"],
        toolAllowlist: ["search-knowledge", "mcp:github:*"],
        model: "claude-sonnet-4-6",
        reasoningEffort: null,
        approvalPolicy: null,
        version: "2.3.4",
        projectId: null,
      });
    });

    it("CUSTOM agents (built-in and project) read back with every field intact", async () => {
      expect(await loadAgentDefinition("custom:c-proj")).toMatchObject({
        ref: "custom:c-proj",
        kind: "custom",
        name: "Reviewer",
        persona: "You review.",
        toolAllowlist: ["search-knowledge"],
        model: "gpt-4.1",
        reasoningEffort: "high",
        skillKeys: [],
        approvalPolicy: null,
        version: "1.0.0",
        projectId: "p1",
      });
      expect(await loadAgentDefinition("custom:c-builtin")).toMatchObject({
        name: "QA",
        toolAllowlist: ["search_documents"],
        reasoningEffort: "medium",
        projectId: null,
      });
      // The custom-agents service still lists them (built-ins first), unchanged.
      const listed = await listAgents({ projectId: "p1" });
      expect(listed.map((a) => a.name)).toEqual(["QA", "Reviewer"]);
      expect(listed[1]).toMatchObject({ tools: ["search-knowledge"], model: "gpt-4.1" });
    });

    it("import/export still round-trips a migrated agent as a version-1 document", async () => {
      const dto = await getAgent("c-proj");
      expect(exportAgent(dto!)).toEqual({
        schemaVersion: 1,
        agent: {
          name: "Reviewer",
          description: "Reviews",
          systemPrompt: "You review.",
          tools: ["search-knowledge"],
          model: "gpt-4.1",
          reasoningEffort: "high",
        },
      });
    });

    it("the project's callable agents: its own + enabled custom agents, and explicitly allowed library agents", async () => {
      const refs = (await listCallableAgents("p1")).map((d) => d.ref).sort();
      expect(refs).toEqual(["custom:c-builtin", "custom:c-proj", "library:a1"]);
    });
  },
);
