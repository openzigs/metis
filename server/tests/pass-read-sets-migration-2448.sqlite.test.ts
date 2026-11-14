/**
 * Issue #2448 — `agent_results.readSourceIds`. The migration and its committed
 * reverse script, applied up -> reverse -> up to a SQLite database holding a
 * row written BEFORE the migration. Prisma Migrate has no down migrations, so
 * the reverse is a hand-run SQL file (server/prisma/rollbacks/).
 *
 * The existing row reads NULL after the migration: its run is `shared` or
 * older, whose rule never reads it. Nothing is backfilled.
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

const MIGRATION = "20261129002448_issue2448_pass_read_sets";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2448 — pass read sets migration: up -> reverse -> up",
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
        (db.prepare(`PRAGMA table_info("agent_results")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const row = () =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "agent_results" WHERE "id" = 'ar-1'`).get() as Record<
            string,
            unknown
          >,
      );
    let seeded: Record<string, unknown>;
    let before: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2448-pass-read-sets-migration", { stopBefore: MIGRATION });
      withDb((db) => {
        // Only the column is under test: the users the rows name are not seeded.
        db.pragma("foreign_keys = OFF");
        const ts = "2026-11-01T00:00:00.000Z";
        db.prepare(
          `INSERT INTO "projects" ("id","name","slug","createdById","updatedAt")
           VALUES ('p-1','Checkout','checkout','u-1',?)`,
        ).run(ts);
        db.prepare(
          `INSERT INTO "analyses" ("id","projectId","status","sourceAccess","updatedAt")
           VALUES ('an-1','p-1','completed','shared',?)`,
        ).run(ts);
        db.prepare(
          `INSERT INTO "agent_results" ("id","analysisId","agentKey","output","updatedAt")
           VALUES ('ar-1','an-1','code','{"summary":"s"}',?)`,
        ).run(ts);
      });
      seeded = row();
      before = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the column, NULL on the existing row; reverse drops it; up again re-applies",
      () => {
        expect(before).not.toContain("readSourceIds");

        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...before, "readSourceIds"]);
        // Not backfilled: NULL, which a `shared` run's rule never reads.
        expect(row()).toEqual({ ...seeded, readSourceIds: null });

        // What the rollback's header says is lost: the recorded read sets.
        withDb((db) =>
          db
            .prepare(
              `UPDATE "agent_results" SET "readSourceIds" = '{"documentIds":["d-1"],"chunkIds":[]}'`,
            )
            .run(),
        );
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(before);
        // Every other column of the row survives.
        expect(row()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(row()).toEqual({ ...seeded, readSourceIds: null });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toContain(
        `ALTER TABLE "agent_results" ADD COLUMN IF NOT EXISTS "readSourceIds" TEXT;`,
      );
      expect(pgDown).toContain(
        `ALTER TABLE "agent_results" DROP COLUMN IF EXISTS "readSourceIds";`,
      );
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
      // No backfill in either direction: the only writes are the schema's.
      expect(pgUp).not.toMatch(/\bUPDATE\b/);
    });
  },
);
