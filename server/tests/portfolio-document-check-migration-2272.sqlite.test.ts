/**
 * Issue #2272 — `portfolio_assessments.sourceDocumentId` and
 * `portfolio_assessments.notChecked`. The migration and its committed reverse
 * script, applied up -> reverse -> up to a SQLite database holding an
 * assessment written BEFORE the migration. Prisma Migrate has no down
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
  onSeededColumns,
} from "./helpers/sqlite-migrated-db.js";

const MIGRATION = "20261124002272_issue2272_portfolio_document_check";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2272 — portfolio document check migration: up -> reverse -> up",
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
    const assessment = () =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "portfolio_assessments" WHERE "id" = 'pa-1'`).get() as Record<
            string,
            unknown
          >,
      );
    let seeded: Record<string, unknown>;
    let columnsBefore: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2272-portfolio-document-check-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        db.prepare(
          `INSERT INTO "portfolio_assessments" ("id","statement","scope","productIds","status","createdById","updatedAt")
           VALUES ('pa-1','Reset by email','product','["p-1"]','completed','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = assessment();
      columnsBefore = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds both columns (an existing check reads no document and nothing not checked); reverse drops them; up again re-applies",
      () => {
        expect(columnsBefore).not.toContain("sourceDocumentId");
        expect(columnsBefore).not.toContain("notChecked");

        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...columnsBefore, "sourceDocumentId", "notChecked"]);
        expect(assessment()).toEqual({ ...seeded, sourceDocumentId: null, notChecked: "[]" });

        // What a document check wrote after the migration is lost by the reverse,
        // which the rollback's header says; every other column survives.
        withDb((db) =>
          db
            .prepare(
              `UPDATE "portfolio_assessments" SET "sourceDocumentId" = ?, "notChecked" = ? WHERE "id" = 'pa-1'`,
            )
            .run("doc-1", JSON.stringify([{ text: "R101", reason: "over-limit", count: null }])),
        );
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(columnsBefore);
        expect(assessment()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(columns()).toContain("sourceDocumentId");
        expect(columns()).toContain("notChecked");
        // Later migrations may add columns to this table (#2345).
        const expected = { ...seeded, sourceDocumentId: null, notChecked: "[]" };
        expect(onSeededColumns({ t: [assessment()] }, { t: [expected] })).toEqual({
          t: [expected],
        });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toContain(
        `ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "sourceDocumentId" TEXT;`,
      );
      expect(pgUp).toContain(
        `ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "notChecked" TEXT NOT NULL DEFAULT '[]';`,
      );
      for (const column of ["sourceDocumentId", "notChecked"]) {
        expect(pgDown).toContain(
          `ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "${column}";`,
        );
      }
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
    });
  },
);
