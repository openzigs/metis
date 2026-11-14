/**
 * Issue #2446 — `analyses.sourceAccess` and the `sourceIds` columns of
 * `findings`, `requirements` and `cross_doc_findings`. The migration and its
 * committed reverse script, applied up -> reverse -> up to a SQLite database
 * holding rows written BEFORE the migration. Prisma Migrate has no down
 * migrations, so the reverse is a hand-run SQL file (server/prisma/rollbacks/).
 *
 * The existing rows are the marker: every one reads NULL after the migration,
 * which is how a run from before #2446 keeps the shared-audience rule (#2314).
 * Nothing is backfilled.
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

const MIGRATION = "20261128002446_issue2446_source_provenance";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Each table the migration changes, and the column it adds. */
const ADDED: ReadonlyArray<readonly [string, string]> = [
  ["analyses", "sourceAccess"],
  ["findings", "sourceIds"],
  ["requirements", "sourceIds"],
  ["cross_doc_findings", "sourceIds"],
];
const SEED: Record<string, string> = {
  analyses: "an-1",
  findings: "f-1",
  requirements: "r-1",
  cross_doc_findings: "c-1",
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2446 — source provenance migration: up -> reverse -> up",
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
    const columns = (table: string) =>
      withDb((db) =>
        (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const row = (table: string) =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "${table}" WHERE "id" = ?`).get(SEED[table]) as Record<
            string,
            unknown
          >,
      );
    const seeded: Record<string, Record<string, unknown>> = {};
    const before: Record<string, string[]> = {};

    beforeAll(() => {
      sqlite = createMigratedSqlite("2446-source-provenance-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        // Only the columns are under test: the users the rows name are not seeded.
        db.pragma("foreign_keys = OFF");
        const ts = "2026-11-01T00:00:00.000Z";
        db.prepare(
          `INSERT INTO "projects" ("id","name","slug","createdById","updatedAt")
           VALUES ('p-1','Checkout','checkout','u-1',?)`,
        ).run(ts);
        db.prepare(
          `INSERT INTO "analyses" ("id","projectId","status","updatedAt") VALUES ('an-1','p-1','completed',?)`,
        ).run(ts);
        db.prepare(
          `INSERT INTO "agent_results" ("id","analysisId","agentKey","updatedAt") VALUES ('ar-1','an-1','code',?)`,
        ).run(ts);
        db.prepare(
          `INSERT INTO "findings" ("id","agentResultId","category","title","body","evidence")
           VALUES ('f-1','ar-1','architecture','t','b','{"citations":[{"documentId":"d-1","chunkIndex":0}]}')`,
        ).run();
        db.prepare(
          `INSERT INTO "requirements" ("id","projectId","analysisId","title","body","labels","updatedAt")
           VALUES ('r-1','p-1','an-1','t','b','["finding:f-1"]',?)`,
        ).run(ts);
        db.prepare(
          `INSERT INTO "cross_doc_findings" ("id","analysisId","kind","title","detail","evidenceIds")
           VALUES ('c-1','an-1','contradiction','t','d','["f-1"]')`,
        ).run();
      });
      for (const [table] of ADDED) {
        seeded[table] = row(table);
        before[table] = columns(table);
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the columns, NULL on every existing row; reverse drops them; up again re-applies",
      () => {
        for (const [table, column] of ADDED) expect(before[table]).not.toContain(column);

        sqlite.apply(MIGRATION);
        for (const [table, column] of ADDED) {
          expect(columns(table), table).toEqual([...before[table]!, column]);
          // The marker of a row from before #2446: NULL, not a backfilled value.
          expect(row(table), table).toEqual({ ...seeded[table], [column]: null });
        }

        // What the rollback's header says is lost: the recorded values.
        withDb((db) => {
          db.prepare(`UPDATE "analyses" SET "sourceAccess" = 'shared'`).run();
          for (const table of ["findings", "requirements", "cross_doc_findings"]) {
            db.prepare(
              `UPDATE "${table}" SET "sourceIds" = '{"documentIds":["d-1"],"chunkIds":[]}'`,
            ).run();
          }
        });
        withDb((db) => db.exec(rollback));
        for (const [table] of ADDED) {
          expect(columns(table), table).toEqual(before[table]);
          // Every other column of every row survives.
          expect(row(table), table).toEqual(seeded[table]);
        }

        sqlite.applyRemaining();
        for (const [table, column] of ADDED) {
          expect(row(table), table).toEqual({ ...seeded[table], [column]: null });
        }
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      for (const [table, column] of ADDED) {
        expect(pgUp).toContain(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" TEXT;`);
        expect(pgDown).toContain(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}";`);
      }
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
      // No backfill in either direction: the only writes are the schema's.
      expect(pgUp).not.toMatch(/\bUPDATE\b/);
    });
  },
);
