/**
 * Epic #547 (Phase 0, #548) — Teams foundation migration sanity.
 *
 * Asserts the `teams_app_installations` + `teams_conversation_references` tables,
 * their unique keys, FK behaviour, and the secret-handling guarantee (the app
 * password is NOT a column — only a `${vault:ref}`) are present in BOTH the
 * SQLite and Postgres migrations, both Prisma schemas declare the models, and the
 * Postgres incremental migration is idempotent (issue #556 from-scratch deploy).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const MIG = "20260629090000_epic547_teams_app_foundation";

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

describe("teams foundation migration (#548)", () => {
  const tables = ["teams_app_installations", "teams_conversation_references"];

  it.each(tables)("SQLite migration creates the %s table", (t) => {
    expect(sqliteMigration).toContain(`CREATE TABLE "${t}"`);
  });

  it.each(tables)("Postgres migration creates the %s table (idempotent)", (t) => {
    expect(postgresMigration).toContain(`CREATE TABLE IF NOT EXISTS "${t}"`);
  });

  it("the app password is NOT a column — only a vault reference is stored", () => {
    expect(sqliteMigration).toMatch(/"appPasswordRef" TEXT NOT NULL/);
    expect(sqliteMigration).not.toMatch(/"appPassword"\s+TEXT/);
    expect(postgresMigration).not.toMatch(/"appPassword"\s+TEXT/);
  });

  it("enforces one installation per (workspace, app)", () => {
    expect(sqliteMigration).toContain(
      'CREATE UNIQUE INDEX "teams_app_installations_workspaceId_appId_key"',
    );
    expect(postgresMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "teams_app_installations_workspaceId_appId_key"',
    );
  });

  it("keys a conversation reference by (workspace, conversation)", () => {
    expect(sqliteMigration).toContain(
      'CREATE UNIQUE INDEX "teams_conversation_references_workspaceId_conversationId_key"',
    );
    expect(postgresMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "teams_conversation_references_workspaceId_conversationId_key"',
    );
  });

  it("installations cascade-delete with their workspace (SQLite)", () => {
    expect(sqliteMigration).toMatch(
      /teams_app_installations_workspaceId_fkey.*REFERENCES "workspaces".*ON DELETE CASCADE/s,
    );
  });

  it("conversation references cascade-delete with their installation (SQLite)", () => {
    expect(sqliteMigration).toMatch(
      /teams_conversation_references_installationId_fkey.*REFERENCES "teams_app_installations".*ON DELETE CASCADE/s,
    );
  });

  it("Postgres FKs are wrapped in pg_constraint existence guards (issue #556)", () => {
    expect(postgresMigration).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
  });

  it("both Prisma schemas declare the models with @@map", () => {
    for (const s of [sqliteSchema, postgresSchema]) {
      expect(s).toMatch(/model TeamsAppInstallation \{/);
      expect(s).toMatch(/model TeamsConversationReference \{/);
      expect(s).toMatch(/@@map\("teams_app_installations"\)/);
      expect(s).toMatch(/@@map\("teams_conversation_references"\)/);
    }
  });

  it("the cumulative Postgres init baseline includes both tables (parity guard)", () => {
    const initSql = readFileSync(
      join(repoRoot, "server/prisma/postgres/migrations/00000000000000_init/migration.sql"),
      "utf-8",
    );
    expect(initSql).toContain('CREATE TABLE "teams_app_installations"');
    expect(initSql).toContain('CREATE TABLE "teams_conversation_references"');
  });
});
