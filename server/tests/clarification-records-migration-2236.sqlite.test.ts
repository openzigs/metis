/**
 * Issue #2236 (epic #2227) — the `clarification_records` table: the migration
 * and its committed reverse script, applied up -> reverse -> up to a SQLite
 * database holding a project written BEFORE the migration. Prisma Migrate has
 * no down migrations, so the reverse is a hand-run SQL file
 * (server/prisma/rollbacks/).
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

const MIGRATION = "20261124002236_issue2236_clarification_records";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2236 — clarification records migration: up -> reverse -> up",
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
    const tables = () =>
      withDb((db) =>
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
            name: string;
          }>
        ).map((t) => t.name),
      );
    const projects = () => withDb((db) => db.prepare(`SELECT "id","name" FROM "projects"`).all());
    const insertRecord = (id: string, key = "k-1") =>
      withDb((db) =>
        db
          .prepare(
            `INSERT INTO "clarification_records" ("id","projectId","origin","questionKey","question","answer","answeredAt","updatedAt")
             VALUES (?, 'proj-1', 'analysis', ?, 'Q?', 'A.', '2026-11-11T00:00:00.000Z', '2026-11-11T00:00:00.000Z')`,
          )
          .run(id, key),
      );
    let seeded: unknown;

    beforeAll(() => {
      sqlite = createMigratedSqlite("2236-clarification-records-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "projects" ("id","name","slug","createdById","createdAt","updatedAt")
           VALUES ('proj-1','P','p','u-1','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = projects();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the empty table; reverse drops it and its rows and leaves projects alone; up again re-creates it",
      () => {
        expect(tables()).not.toContain("clarification_records");
        sqlite.apply(MIGRATION);
        expect(tables()).toContain("clarification_records");
        insertRecord("cr-1");
        // One record per (project, question key).
        expect(() => insertRecord("cr-2")).toThrow(/UNIQUE/);
        insertRecord("cr-3", "k-2");
        expect(
          withDb((db) =>
            db
              .prepare(
                `SELECT "status","requirementIds","productIds","sourceHeadingPath" FROM "clarification_records" WHERE "id" = 'cr-1'`,
              )
              .get(),
          ),
        ).toEqual({
          status: "settled",
          requirementIds: "[]",
          productIds: "[]",
          sourceHeadingPath: "[]",
        });
        withDb((db) => db.exec(rollback));
        expect(tables()).not.toContain("clarification_records");
        expect(projects()).toEqual(seeded);
        sqlite.applyRemaining();
        expect(tables()).toContain("clarification_records");
        expect(
          withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM "clarification_records"`).get()),
        ).toEqual({ n: 0 });
        expect(projects()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin creates and drops the same table, idempotently", () => {
      expect(pgUp).toMatch(/CREATE TABLE IF NOT EXISTS "clarification_records"/);
      expect(pgUp).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS "clarification_records_projectId_questionKey_key"/,
      );
      expect(pgUp).toMatch(
        /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'clarification_records_projectId_fkey'\)/,
      );
      expect(pgDown).toMatch(/DROP TABLE IF EXISTS "clarification_records" CASCADE;/);
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
