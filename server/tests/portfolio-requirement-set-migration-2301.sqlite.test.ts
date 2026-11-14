/**
 * Issue #2301 — `portfolio_assessments.sourceRequirementIds`. The migration and
 * its committed reverse script, applied up -> reverse -> up to a SQLite
 * database holding a portfolio check written BEFORE the migration. Prisma
 * Migrate has no down migrations, so the reverse is a hand-run SQL file
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

const MIGRATION = "20261129002301_issue2301_portfolio_requirement_set";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2301 — portfolio requirement set migration: up -> reverse -> up",
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
        (
          db.prepare(`PRAGMA table_info("portfolio_assessments")`).all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
    const row = () =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "portfolio_assessments" WHERE "id" = 'pa-1'`).get() as Record<
            string,
            unknown
          >,
      );
    let seeded: Record<string, unknown>;
    let before: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2301-portfolio-requirement-set-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        // The check's starter is not seeded: only the column is under test.
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "portfolio_assessments" ("id","statement","scope","productIds","status","createdById","updatedAt")
           VALUES ('pa-1','Reset by email','product','["p-1"]','completed','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = row();
      before = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the column (an existing check names no set); reverse drops it; up again re-applies",
      () => {
        expect(before).not.toContain("sourceRequirementIds");

        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...before, "sourceRequirementIds"]);
        expect(row()).toEqual({ ...seeded, sourceRequirementIds: "[]" });

        // What a set check wrote after the migration is lost by the reverse,
        // which the rollback's header says; every other column survives.
        withDb((db) =>
          db
            .prepare(`UPDATE "portfolio_assessments" SET "sourceRequirementIds" = '["r-1","r-2"]'`)
            .run(),
        );
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(before);
        expect(row()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(columns()).toContain("sourceRequirementIds");
        expect(row()).toMatchObject({ sourceRequirementIds: "[]" });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toContain(
        `ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "sourceRequirementIds" TEXT NOT NULL DEFAULT '[]';`,
      );
      expect(pgDown).toContain(
        `ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "sourceRequirementIds";`,
      );
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
    });
  },
);
