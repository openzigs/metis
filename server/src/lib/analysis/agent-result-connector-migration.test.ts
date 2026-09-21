/**
 * Issue #763 (Epic #727) — `agent_results.connectorId` migration sanity.
 *
 * Asserts the nullable `connectorId` column is added in BOTH the SQLite and
 * Postgres incremental migrations, that the Postgres ADD COLUMN is idempotent
 * (issue #556 from-scratch deploy over the cumulative init baseline), that the
 * cumulative Postgres init baseline already carries the column (parity guard), and
 * that both Prisma schemas declare the field on the AgentResult model.
 *
 * The column lets `persistAgentResult` scope its `replace`-delete per connector so
 * a multi-repo agentic run keeps EVERY connector's `code` findings — not just the
 * last (the silent replace-by-agentKey data-loss bug).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const MIG = "20260711000000_issue763_agent_result_connector";

const sqliteMigration = readFileSync(
  join(repoRoot, "server/prisma/migrations", MIG, "migration.sql"),
  "utf-8",
);
const postgresMigration = readFileSync(
  join(repoRoot, "server/prisma/postgres/migrations", MIG, "migration.sql"),
  "utf-8",
);
const sqliteSchema = readFileSync(join(repoRoot, "server/prisma/schema.prisma"), "utf-8");
const postgresSchema = readFileSync(
  join(repoRoot, "server/prisma/postgres/schema.prisma"),
  "utf-8",
);
const postgresInit = readFileSync(
  join(repoRoot, "server/prisma/postgres/migrations/00000000000000_init/migration.sql"),
  "utf-8",
);

describe("agent result connector migration (#763)", () => {
  it("SQLite migration adds the nullable connectorId column", () => {
    expect(sqliteMigration).toContain('ALTER TABLE "agent_results" ADD COLUMN "connectorId" TEXT');
    // Nullable: no NOT NULL / DEFAULT — re-runs recompute, old rows read null.
    expect(sqliteMigration).not.toMatch(/"connectorId" TEXT NOT NULL/);
  });

  it("Postgres migration adds the column idempotently (issue #556)", () => {
    expect(postgresMigration).toContain(
      'ALTER TABLE "agent_results" ADD COLUMN IF NOT EXISTS "connectorId" TEXT',
    );
  });

  it("the cumulative Postgres init baseline carries the column (parity guard)", () => {
    const createTable = postgresInit.slice(postgresInit.indexOf('CREATE TABLE "agent_results"'));
    const body = createTable.slice(0, createTable.indexOf(");"));
    expect(body).toContain('"connectorId" TEXT');
  });

  it("both Prisma schemas declare connectorId on the AgentResult model", () => {
    for (const s of [sqliteSchema, postgresSchema]) {
      const model = s.slice(s.indexOf("model AgentResult {"));
      const body = model.slice(0, model.indexOf("@@map"));
      expect(body).toMatch(/connectorId\s+String\?/);
    }
  });
});
