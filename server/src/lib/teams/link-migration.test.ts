/**
 * Epic #547 (Phase 1, #549) — link + identity migration sanity.
 *
 * Asserts the `teams_channel_links` + `teams_user_identities` tables, their
 * unique keys (the cardinality + tenant-scoping guarantees), FK cascade
 * behaviour, that BOTH Prisma schemas declare the models, that the Postgres
 * incremental migration is idempotent (issue #556 from-scratch deploy), and that
 * the cumulative Postgres init baseline includes both tables (parity guard).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const MIG = "20260629100000_epic547_teams_link_identity";

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

describe("teams link + identity migration (#549)", () => {
  const tables = ["teams_channel_links", "teams_user_identities"];

  it.each(tables)("SQLite migration creates the %s table", (t) => {
    expect(sqliteMigration).toContain(`CREATE TABLE "${t}"`);
  });

  it.each(tables)("Postgres migration creates the %s table (idempotent)", (t) => {
    expect(postgresMigration).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
  });

  it("enforces one thread per channel (workspace, conversation) — channel cardinality", () => {
    expect(sqliteMigration).toContain(
      'CREATE UNIQUE INDEX "teams_channel_links_workspaceId_conversationId_key"',
    );
    expect(postgresMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "teams_channel_links_workspaceId_conversationId_key"',
    );
  });

  it("enforces one channel per thread — thread cardinality (global unique threadId)", () => {
    expect(sqliteMigration).toContain('CREATE UNIQUE INDEX "teams_channel_links_threadId_key"');
    expect(postgresMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "teams_channel_links_threadId_key"',
    );
  });

  it("keys the AAD identity binding by (tenantId, aadObjectId) — tenant-scoped isolation", () => {
    expect(sqliteMigration).toContain(
      'CREATE UNIQUE INDEX "teams_user_identities_tenantId_aadObjectId_key"',
    );
    expect(postgresMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "teams_user_identities_tenantId_aadObjectId_key"',
    );
  });

  it("channel links cascade-delete with their thread (SQLite)", () => {
    expect(sqliteMigration).toMatch(
      /teams_channel_links_threadId_fkey.*REFERENCES "discussion_threads".*ON DELETE CASCADE/s,
    );
  });

  it("channel links cascade-delete with their workspace (SQLite)", () => {
    expect(sqliteMigration).toMatch(
      /teams_channel_links_workspaceId_fkey.*REFERENCES "workspaces".*ON DELETE CASCADE/s,
    );
  });

  it("identity bindings cascade-delete with their user (SQLite)", () => {
    expect(sqliteMigration).toMatch(
      /teams_user_identities_userId_fkey.*REFERENCES "users".*ON DELETE CASCADE/s,
    );
  });

  it("Postgres FKs are wrapped in pg_constraint existence guards (issue #556)", () => {
    expect(postgresMigration).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
  });

  it("both Prisma schemas declare the models with @@map", () => {
    for (const s of [sqliteSchema, postgresSchema]) {
      expect(s).toMatch(/model TeamsChannelLink \{/);
      expect(s).toMatch(/model TeamsUserIdentity \{/);
      expect(s).toMatch(/@@map\("teams_channel_links"\)/);
      expect(s).toMatch(/@@map\("teams_user_identities"\)/);
    }
  });

  it("the cumulative Postgres init baseline includes both tables (parity guard)", () => {
    const initSql = readFileSync(
      join(repoRoot, "server/prisma/postgres/migrations/00000000000000_init/migration.sql"),
      "utf-8",
    );
    expect(initSql).toContain('CREATE TABLE "teams_channel_links"');
    expect(initSql).toContain('CREATE TABLE "teams_user_identities"');
  });
});
