/**
 * Epic #726 (#736) — `requirements.coverage` migration sanity.
 *
 * Asserts the nullable `coverage` column is added in BOTH the SQLite and Postgres
 * incremental migrations, that the Postgres ADD COLUMN is idempotent (issue #556
 * from-scratch deploy over the cumulative init baseline), that the cumulative
 * Postgres init baseline already carries the column (parity guard), and that both
 * Prisma schemas declare the field on the Requirement model.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const MIG = "20260710000000_issue736_requirement_coverage";

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

describe("requirement coverage migration (#736)", () => {
  it("SQLite migration adds the nullable coverage column", () => {
    expect(sqliteMigration).toContain('ALTER TABLE "requirements" ADD COLUMN "coverage" TEXT');
    // Nullable: no NOT NULL / DEFAULT — re-runs recompute, old rows read null.
    expect(sqliteMigration).not.toMatch(/"coverage" TEXT NOT NULL/);
  });

  it("Postgres migration adds the column idempotently (issue #556)", () => {
    expect(postgresMigration).toContain(
      'ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "coverage" TEXT',
    );
  });

  it("the cumulative Postgres init baseline carries the coverage column (parity guard)", () => {
    // The requirements CREATE TABLE must include the column so a from-scratch
    // deploy has it before the idempotent incremental no-ops.
    const createReq = postgresInit.slice(postgresInit.indexOf('CREATE TABLE "requirements"'));
    const body = createReq.slice(0, createReq.indexOf(");"));
    expect(body).toContain('"coverage" TEXT');
  });

  it("both Prisma schemas declare coverage on the Requirement model", () => {
    for (const s of [sqliteSchema, postgresSchema]) {
      const model = s.slice(s.indexOf("model Requirement {"));
      const body = model.slice(0, model.indexOf("}"));
      expect(body).toMatch(/coverage\s+String\?/);
    }
  });
});
