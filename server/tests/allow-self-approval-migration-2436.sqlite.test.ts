/**
 * Issue #2436 — `projects.allowSelfApproval`. The migration and its committed
 * reverse script, applied up -> reverse -> up to a SQLite database holding a
 * project written BEFORE the migration. Prisma Migrate has no down migrations,
 * so the reverse is a hand-run SQL file (server/prisma/rollbacks/).
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

const MIGRATION = "20261127002436_issue2436_allow_self_approval";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2436 — allow self-approval migration: up -> reverse -> up",
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
        (db.prepare(`PRAGMA table_info("projects")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const project = () =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "projects" WHERE "id" = 'p-1'`).get() as Record<
            string,
            unknown
          >,
      );
    let seeded: Record<string, unknown>;
    let before: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2436-allow-self-approval-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        // The creator is not seeded: only the column is under test.
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "projects" ("id","name","slug","createdById","updatedAt")
           VALUES ('p-1','Checkout','checkout','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = project();
      before = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the column, off for an existing project; reverse drops it; up again re-applies",
      () => {
        expect(before).not.toContain("allowSelfApproval");

        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...before, "allowSelfApproval"]);
        expect(project()).toEqual({ ...seeded, allowSelfApproval: 0 });

        // A project that allowed it loses the setting on the reverse, which the
        // rollback's header says; every other column survives.
        withDb((db) => db.prepare(`UPDATE "projects" SET "allowSelfApproval" = 1`).run());
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(before);
        expect(project()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(project()).toMatchObject({ allowSelfApproval: 0 });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toContain(
        `ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "allowSelfApproval" BOOLEAN NOT NULL DEFAULT false;`,
      );
      expect(pgDown).toContain(`ALTER TABLE "projects" DROP COLUMN IF EXISTS "allowSelfApproval";`);
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
    });
  },
);
