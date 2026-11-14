/**
 * Issue #2498 — `portfolio_assessments.sourceRows`. The migration and its
 * committed reverse script, applied up -> reverse -> up to a SQLite database
 * holding checks written BEFORE the migration. Prisma Migrate has no down
 * migrations, so the reverse is a hand-run SQL file (server/prisma/rollbacks/).
 *
 * The backfill records, for a check started from a requirement or a change
 * request, the rows that exist when it runs (the rows the view read before
 * #2498), so a row hard-deleted afterwards still counts. A statement check
 * reads no row and records none.
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

const MIGRATION = "20261129002498_issue2498_portfolio_source_rows";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_SOURCES = JSON.stringify({ documentIds: ["d-secret"], chunkIds: [] });
const ts = "2026-11-01T00:00:00.000Z";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2498 — portfolio source rows migration: up -> reverse -> up",
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
    const check = (id: string) =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "portfolio_assessments" WHERE "id" = ?`).get(id) as Record<
            string,
            unknown
          >,
      );
    const recorded = (id: string) => {
      const raw = check(id).sourceRows;
      if (raw === null) return null;
      return (JSON.parse(raw as string) as Array<{ id: string }>).sort((x, y) =>
        x.id.localeCompare(y.id),
      );
    };
    const IDS = ["pa-cr", "pa-req", "pa-req-gone", "pa-statement"];
    const seeded: Record<string, Record<string, unknown>> = {};
    let before: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2498-portfolio-source-rows-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        // Only the column and its backfill are under test: users are not seeded.
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "projects" ("id","name","slug","createdById","updatedAt")
           VALUES ('p-1','Checkout','checkout','u-1',?)`,
        ).run(ts);
        for (const id of ["an-1", "an-2"]) {
          db.prepare(
            `INSERT INTO "analyses" ("id","projectId","status","updatedAt") VALUES (?,'p-1','completed',?)`,
          ).run(id, ts);
        }
        const requirement = db.prepare(
          `INSERT INTO "requirements" ("id","projectId","analysisId","title","body","sourceIds","updatedAt")
           VALUES (?,'p-1',?,?,'b',?,?)`,
        );
        requirement.run("r-open", "an-1", "Customers can pay", null, ts);
        requirement.run("r-secret", "an-1", "Payroll export", SECRET_SOURCES, ts);
        requirement.run("r-other", "an-2", "Another run", null, ts);
        const insert = db.prepare(
          `INSERT INTO "portfolio_assessments"
             ("id","statement","scope","status","createdById","updatedAt","sourceRequirementId","sourceAnalysisId")
           VALUES (?,'s','product','completed','u-1',?,?,?)`,
        );
        insert.run("pa-cr", ts, null, "an-1");
        insert.run("pa-req", ts, "r-secret", null);
        // Its requirement was deleted before the migration: the link was set null.
        insert.run("pa-req-gone", ts, null, null);
        insert.run("pa-statement", ts, null, null);
      });
      for (const id of IDS) seeded[id] = check(id);
      before = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the column and records each requirement or change-request check's rows; reverse drops it; up again re-applies",
      () => {
        expect(before).not.toContain("sourceRows");

        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...before, "sourceRows"]);
        // The change request's rows, of that run only, with their sources (NULL kept as null).
        expect(recorded("pa-cr")).toEqual([
          { id: "r-open", analysisId: "an-1", sourceIds: null },
          { id: "r-secret", analysisId: "an-1", sourceIds: SECRET_SOURCES },
        ]);
        expect(recorded("pa-req")).toEqual([
          { id: "r-secret", analysisId: "an-1", sourceIds: SECRET_SOURCES },
        ]);
        // Nothing to record from: these stay unrecorded.
        expect(recorded("pa-req-gone")).toBeNull();
        expect(recorded("pa-statement")).toBeNull();
        for (const id of IDS) {
          const { sourceRows: _sourceRows, ...rest } = check(id);
          expect(rest).toEqual(seeded[id]);
        }

        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(before);
        for (const id of IDS) expect(check(id)).toEqual(seeded[id]);

        sqlite.applyRemaining();
        expect(columns()).toContain("sourceRows");
        expect(recorded("pa-req")).toEqual([
          { id: "r-secret", analysisId: "an-1", sourceIds: SECRET_SOURCES },
        ]);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toContain(
        `ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "sourceRows" TEXT;`,
      );
      // The backfill fills only an unrecorded check, so a re-run changes nothing.
      expect(pgUp).toMatch(/WHERE "pa"\."sourceRows" IS NULL/);
      expect(pgUp).toContain(`'[]'`);
      expect(pgDown).toContain(
        `ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "sourceRows";`,
      );
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
    });
  },
);
