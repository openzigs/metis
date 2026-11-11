/**
 * Issue #2238 — `ai_sessions.scopeProjectIds` and `ai_sessions.scopeWorkspaceId`,
 * the scope of a multi-product (or workspace) chat. The migration and its
 * committed reverse script, applied up -> reverse -> up to a SQLite database
 * holding a session written BEFORE the migration. Prisma Migrate has no down
 * migrations, so the reverse is a hand-run SQL file (server/prisma/rollbacks/).
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

const MIGRATION = "20261123002238_issue2238_multi_product_chat_scope";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2238 — ai_sessions scope columns migration: up -> reverse -> up",
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
    const columns = () =>
      withDb((db) =>
        (db.prepare(`PRAGMA table_info("ai_sessions")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const session = () =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "ai_sessions" WHERE "id" = 's-1'`).get() as Record<
            string,
            unknown
          >,
      );
    let seeded: Record<string, unknown>;
    let columnsBefore: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2238-multi-product-chat-scope-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        db.prepare(
          `INSERT INTO "users" ("id","username","displayName","email","updatedAt")
           VALUES ('u-1','u-1','U','u@x.test','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "ai_sessions" ("id","userId","provider","model","updatedAt")
           VALUES ('s-1','u-1','anthropic','claude','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = session();
      columnsBefore = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds both nullable columns (an existing session reads null); reverse drops them; up again re-applies",
      () => {
        expect(columnsBefore).not.toContain("scopeProjectIds");
        expect(columnsBefore).not.toContain("scopeWorkspaceId");

        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...columnsBefore, "scopeProjectIds", "scopeWorkspaceId"]);
        expect(session()).toEqual({ ...seeded, scopeProjectIds: null, scopeWorkspaceId: null });

        // A multi-product scope written after the migration is lost by the reverse,
        // which the rollback's header says; every other column survives.
        withDb((db) =>
          db
            .prepare(`UPDATE "ai_sessions" SET "scopeProjectIds" = ? WHERE "id" = 's-1'`)
            .run(JSON.stringify(["p-1", "p-2"])),
        );
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(columnsBefore);
        expect(session()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(columns()).toContain("scopeProjectIds");
        expect(columns()).toContain("scopeWorkspaceId");
        expect(session()).toEqual({ ...seeded, scopeProjectIds: null, scopeWorkspaceId: null });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      for (const column of ["scopeProjectIds", "scopeWorkspaceId"]) {
        expect(pgUp).toContain(
          `ALTER TABLE "ai_sessions" ADD COLUMN IF NOT EXISTS "${column}" TEXT;`,
        );
        expect(pgDown).toContain(`ALTER TABLE "ai_sessions" DROP COLUMN IF EXISTS "${column}";`);
      }
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
    });
  },
);
