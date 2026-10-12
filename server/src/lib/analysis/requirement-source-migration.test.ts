/**
 * Issue #1063 — `requirements.sourceCandidateIds` migration sanity.
 *
 * Asserts the nullable column is added in BOTH the SQLite and the Postgres
 * incremental migration under the same name, that the Postgres ADD COLUMN is
 * idempotent (issue #556 from-scratch deploy), that neither backfills, and that
 * both Prisma schemas declare the field on the Requirement model.
 *
 * `tests/requirement-source-items-1063.sqlite.test.ts` applies the SQLite
 * migration chain for real; this guards the pair staying in step.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const MIG = "20261018001063_issue1063_requirement_source_candidates";

const sqliteDir = join(repoRoot, "server/prisma/migrations");
const postgresDir = join(repoRoot, "server/prisma/postgres/migrations");
const sqliteMigration = readFileSync(join(sqliteDir, MIG, "migration.sql"), "utf-8");
const postgresMigration = readFileSync(join(postgresDir, MIG, "migration.sql"), "utf-8");
const sqliteSchema = readFileSync(join(repoRoot, "server/prisma/schema.prisma"), "utf-8");
const postgresSchema = readFileSync(
  join(repoRoot, "server/prisma/postgres/schema.prisma"),
  "utf-8",
);

/** SQL statements with comment lines removed. */
const statements = (sql: string): string[] =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

describe("requirement source-candidates migration (#1063)", () => {
  it("SQLite migration adds exactly one nullable column, with no default", () => {
    expect(statements(sqliteMigration)).toEqual([
      'ALTER TABLE "requirements" ADD COLUMN "sourceCandidateIds" TEXT',
    ]);
  });

  it("Postgres migration adds the same column idempotently (issue #556)", () => {
    expect(statements(postgresMigration)).toEqual([
      'ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "sourceCandidateIds" TEXT',
    ]);
  });

  it("neither migration backfills or constrains the column", () => {
    for (const sql of [sqliteMigration, postgresMigration]) {
      const body = statements(sql).join(";");
      expect(body).not.toMatch(/\bUPDATE\b|\bNOT NULL\b|\bDEFAULT\b/i);
    }
  });

  it("both Prisma schemas declare the nullable field on the Requirement model", () => {
    for (const schema of [sqliteSchema, postgresSchema]) {
      const model = schema.slice(schema.indexOf("model Requirement {"));
      const body = model.slice(0, model.indexOf("\n}"));
      expect(body).toMatch(/\n\s+sourceCandidateIds\s+String\?\n/);
    }
  });
});
