/**
 * Issue #1947 (epic #1866) — `governing_document_revisions.extractionStartedAt`
 * and the workspace-level `token_usages` row (nullable `projectId`, new
 * `workspaceId`): the migration and its committed reverse script, applied
 * up -> reverse -> up to a SQLite database holding rows written BEFORE the
 * migration. Prisma Migrate has no down migrations, so the reverse is a
 * hand-run SQL file (server/prisma/rollbacks/).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const MIGRATION = "20261118001947_issue1947_governing_extraction_retry_metering";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1947 — extraction start time and workspace-level token usage migration: up -> reverse -> up",
  () => {
    let sqlite: MigratedSqlite;
    const rollback = readFileSync(
      path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
      "utf-8",
    );
    const pgUp = readFileSync(
      path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
      "utf-8",
    );
    const pgDown = readFileSync(
      path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
      "utf-8",
    );
    const withDb = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(sqlite.dbFile);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    type Column = { name: string; notnull: number };
    const columns = (table: string) =>
      withDb((db) => db.prepare(`PRAGMA table_info("${table}")`).all() as Column[]);
    const names = (table: string) => columns(table).map((c) => c.name);
    const indexes = () =>
      withDb((db) =>
        (db.prepare(`PRAGMA index_list("token_usages")`).all() as Array<{ name: string }>)
          .map((i) => i.name)
          .sort(),
      );
    const usageRows = () =>
      withDb((db) =>
        db
          .prepare(
            `SELECT "id","projectId","provider","model","totalTokens","costUsd","userId","agentStep" FROM "token_usages" ORDER BY "id"`,
          )
          .all(),
      );
    const revisionRow = () =>
      withDb((db) =>
        db
          .prepare(
            `SELECT "id","documentId","revisionLabel","extractionState","extractionError","droppedUnverified" FROM "governing_document_revisions"`,
          )
          .all(),
      );
    let seededUsage: unknown;
    let seededRevision: unknown;
    let revisionBefore: string[];
    let usageBefore: string[];
    let indexesBefore: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("1947-extraction-retry-metering-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "governing_document_revisions" ("id","documentId","revisionLabel","effectiveDate","storagePath","contentHash","mimeType","sizeBytes","extractedText","indexState","extractionState","uploadedById","createdAt")
           VALUES ('rev-1','doc-1','v1','2026-01-01T00:00:00.000Z','governing-ws/abc','abc','text/markdown',10,'Policy text','indexed','running','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "token_usages" ("id","projectId","provider","model","inputTokens","outputTokens","totalTokens","costUsd","userId","agentStep","createdAt")
           VALUES ('tu-1','p-1','anthropic','claude-sonnet-5-5',100,20,120,0.0012,'u-1','chat','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seededUsage = usageRows();
      seededRevision = revisionRow();
      revisionBefore = names("governing_document_revisions");
      usageBefore = names("token_usages");
      indexesBefore = indexes();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the start time and a workspace-level usage row; reverse drops both and restores NOT NULL; up again re-applies",
      () => {
        expect(revisionBefore).not.toContain("extractionStartedAt");
        expect(usageBefore).not.toContain("workspaceId");
        expect(columns("token_usages").find((c) => c.name === "projectId")?.notnull).toBe(1);

        sqlite.apply(MIGRATION);
        expect(names("governing_document_revisions")).toEqual([
          ...revisionBefore,
          "extractionStartedAt",
        ]);
        expect(names("token_usages")).toEqual(
          expect.arrayContaining([...usageBefore, "workspaceId"]),
        );
        expect(columns("token_usages").find((c) => c.name === "projectId")?.notnull).toBe(0);
        expect(indexes()).toEqual(
          [...indexesBefore, "token_usages_workspaceId_createdAt_idx"].sort(),
        );
        // Existing rows survive the rebuild verbatim, and read null in the new columns.
        expect(usageRows()).toEqual(seededUsage);
        expect(revisionRow()).toEqual(seededRevision);
        expect(
          withDb((db) =>
            db.prepare(`SELECT "extractionStartedAt" FROM "governing_document_revisions"`).get(),
          ),
        ).toEqual({ extractionStartedAt: null });
        expect(
          withDb((db) => db.prepare(`SELECT "workspaceId" FROM "token_usages"`).get()),
        ).toEqual({ workspaceId: null });

        // A workspace-level row: no project.
        withDb((db) =>
          db
            .prepare(
              `INSERT INTO "token_usages" ("id","projectId","workspaceId","provider","model","totalTokens","agentStep")
               VALUES ('tu-ws',NULL,'ws-1','anthropic','claude-sonnet-5-5',50,'governing.rule-extraction')`,
            )
            .run(),
        );
        expect(usageRows()).toHaveLength(2);

        withDb((db) => db.exec(rollback));
        expect(names("governing_document_revisions")).toEqual(revisionBefore);
        // The rebuild orders columns as the schema does; the set is what must match.
        expect(names("token_usages").sort()).toEqual([...usageBefore].sort());
        expect(columns("token_usages").find((c) => c.name === "projectId")?.notnull).toBe(1);
        expect(indexes()).toEqual(indexesBefore);
        // The workspace-level row is gone; the project's row is untouched.
        expect(usageRows()).toEqual(seededUsage);
        expect(revisionRow()).toEqual(seededRevision);

        sqlite.applyRemaining();
        expect(names("governing_document_revisions")).toContain("extractionStartedAt");
        expect(names("token_usages")).toContain("workspaceId");
        expect(usageRows()).toEqual(seededUsage);
        expect(revisionRow()).toEqual(seededRevision);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toMatch(/ADD COLUMN IF NOT EXISTS "extractionStartedAt" TIMESTAMP\(3\);/);
      expect(pgUp).toMatch(/ADD COLUMN IF NOT EXISTS "workspaceId" TEXT;/);
      expect(pgUp).toMatch(/ALTER COLUMN "projectId" DROP NOT NULL;/);
      expect(pgUp).toMatch(/CREATE INDEX IF NOT EXISTS "token_usages_workspaceId_createdAt_idx"/);
      expect(pgDown).toMatch(/DROP COLUMN IF EXISTS "extractionStartedAt";/);
      expect(pgDown).toMatch(/DELETE FROM "token_usages" WHERE "projectId" IS NULL;/);
      expect(pgDown).toMatch(/ALTER COLUMN "projectId" SET NOT NULL;/);
      expect(pgDown).toMatch(/DROP COLUMN IF EXISTS "workspaceId";/);
      // NOT NULL is restored only after the rows that would break it are gone.
      expect(pgDown.indexOf('WHERE "projectId" IS NULL')).toBeLessThan(
        pgDown.indexOf("SET NOT NULL"),
      );
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
