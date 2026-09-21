/**
 * Epic #727 (#740) — `findings.verificationStatus` migration sanity.
 *
 * Asserts the nullable `verificationStatus` column is added in BOTH the SQLite and
 * Postgres incremental migrations, that the Postgres ADD COLUMN is idempotent
 * (issue #556 from-scratch deploy over the cumulative init baseline), that the
 * cumulative Postgres init baseline already carries the column (parity guard), and
 * that both Prisma schemas declare the field on the Finding model.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const MIG = "20260710120000_issue740_finding_verification";

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

describe("finding verification migration (#740)", () => {
  it("SQLite migration adds the nullable verificationStatus column", () => {
    expect(sqliteMigration).toContain(
      'ALTER TABLE "findings" ADD COLUMN "verificationStatus" TEXT',
    );
    // Nullable: no NOT NULL / DEFAULT — re-runs recompute, old rows read null.
    expect(sqliteMigration).not.toMatch(/"verificationStatus" TEXT NOT NULL/);
  });

  it("Postgres migration adds the column idempotently (issue #556)", () => {
    expect(postgresMigration).toContain(
      'ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "verificationStatus" TEXT',
    );
  });

  it("the cumulative Postgres init baseline carries the column (parity guard)", () => {
    const createFindings = postgresInit.slice(postgresInit.indexOf('CREATE TABLE "findings"'));
    const body = createFindings.slice(0, createFindings.indexOf(");"));
    expect(body).toContain('"verificationStatus" TEXT');
  });

  it("both Prisma schemas declare verificationStatus on the Finding model", () => {
    for (const s of [sqliteSchema, postgresSchema]) {
      const model = s.slice(s.indexOf("model Finding {"));
      const body = model.slice(0, model.indexOf("@@map"));
      expect(body).toMatch(/verificationStatus\s+String\?/);
    }
  });
});
