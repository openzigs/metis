/**
 * Issue #2341 — `analyses.title`. The migration and its committed reverse
 * script, applied up -> reverse -> up to a SQLite database holding a run
 * written BEFORE the migration. Prisma Migrate has no down migrations, so the
 * reverse is a hand-run SQL file (server/prisma/rollbacks/).
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

const MIGRATION = "20261125002341_issue2341_change_request_title";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2341 — change request title migration: up -> reverse -> up",
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
        (db.prepare(`PRAGMA table_info("analyses")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const run = () =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "analyses" WHERE "id" = 'an-1'`).get() as Record<
            string,
            unknown
          >,
      );
    let seeded: Record<string, unknown>;
    let columnsBefore: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2341-change-request-title-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        db.prepare(
          `INSERT INTO "users" ("id","username","displayName","email","updatedAt")
           VALUES ('u-1','u-1','u','u-1@example.test','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "projects" ("id","name","slug","createdById","updatedAt")
           VALUES ('p-1','p','p-1','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "analyses" ("id","projectId","status","metadata","updatedAt")
           VALUES ('an-1','p-1','completed','{"documentIds":["d-1"]}','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = run();
      columnsBefore = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds a nullable title and titleGenerated (an existing run reads NULL, false); reverse drops both; up again re-applies",
      () => {
        expect(columnsBefore).not.toContain("title");

        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...columnsBefore, "title", "titleGenerated"]);
        // The startup backfill (not the migration) names an existing run.
        expect(run()).toEqual({ ...seeded, title: null, titleGenerated: 0 });

        // A title written after the migration is lost by the reverse, which the
        // rollback's header says; every other column survives.
        withDb((db) =>
          db
            .prepare(`UPDATE "analyses" SET "title" = ?, "titleGenerated" = 1 WHERE "id" = 'an-1'`)
            .run("Checkout v2"),
        );
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(columnsBefore);
        expect(run()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(columns()).toEqual([...columnsBefore, "title", "titleGenerated"]);
        expect(run()).toEqual({ ...seeded, title: null, titleGenerated: 0 });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toContain(`ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "title" TEXT;`);
      expect(pgUp).toContain(
        `ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "titleGenerated" BOOLEAN NOT NULL DEFAULT false;`,
      );
      expect(pgDown).toContain(`ALTER TABLE "analyses" DROP COLUMN IF EXISTS "title";`);
      expect(pgDown).toContain(`ALTER TABLE "analyses" DROP COLUMN IF EXISTS "titleGenerated";`);
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
    });
  },
);
