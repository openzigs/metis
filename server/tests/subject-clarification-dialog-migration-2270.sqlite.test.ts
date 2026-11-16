/**
 * Issue #2270 — the subject clarification dialog migration and its committed
 * reverse script, applied up -> reverse -> up to a SQLite database seeded with
 * rows written BEFORE the migration. Prisma Migrate has no down migrations, so
 * the reverse is a hand-run SQL file (server/prisma/rollbacks/); this proves it
 * works, leaves every pre-existing row as it was at each step, and lets
 * `prisma migrate deploy` apply the migration again afterwards. It also pins the
 * table's key (one dialog per impact run, one per portfolio check) and that a
 * deleted run or check takes its dialog with it.
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

const MIGRATION = "20261202002270_issue2270_subject_clarification_dialogs";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(path.join(SERVER_ROOT, ...parts), "utf-8");
const ROLLBACK_SQL = read("prisma", "rollbacks", `${MIGRATION}.sql`);
const PG_ROLLBACK_SQL = read("prisma", "postgres", "rollbacks", `${MIGRATION}.sql`);
const PG_MIGRATION_SQL = read("prisma", "postgres", "migrations", MIGRATION, "migration.sql");
const PG_INIT_SQL = read(
  "prisma",
  "postgres",
  "migrations",
  "00000000000000_init",
  "migration.sql",
);
const TABLE = "subject_clarification_dialogs";
const SEEDED_TABLES = ["users", "projects", "impact_analyses", "portfolio_assessments"];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2270 — subject clarification dialog migration: up -> reverse -> up",
  () => {
    let sqlite: MigratedSqlite;

    const withDb = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(sqlite.dbFile);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    const tables = (): string[] =>
      withDb((db) =>
        (
          db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
            name: string;
          }>
        ).map((t) => t.name),
      );
    const existing = () =>
      withDb((db) =>
        Object.fromEntries(
          SEEDED_TABLES.map((t) => [t, db.prepare(`SELECT * FROM "${t}" ORDER BY "id"`).all()]),
        ),
      );
    const applied = (): boolean =>
      withDb(
        (db) =>
          (
            db
              .prepare(
                `SELECT COUNT(*) AS n FROM "_prisma_migrations" WHERE "migration_name" = ? AND "finished_at" IS NOT NULL`,
              )
              .get(MIGRATION) as { n: number }
          ).n === 1,
      );
    const insertImpact = (id: string) =>
      sqlite.exec(
        `INSERT INTO "impact_analyses" ("id","startedById","updatedAt") VALUES (?,'u-1',?)`,
        [id, new Date().toISOString()],
      );
    const insertAssessment = (id: string) =>
      sqlite.exec(
        `INSERT INTO "portfolio_assessments" ("id","statement","scope","createdById","updatedAt")
         VALUES (?,'s','all-accessible','u-1',?)`,
        [id, new Date().toISOString()],
      );
    const insertDialog = (id: string, subject: { impact?: string; portfolio?: string }) =>
      sqlite.exec(
        `INSERT INTO "${TABLE}" ("id","impactAnalysisId","portfolioAssessmentId","projectId","documentId","requirements","updatedAt")
         VALUES (?,?,?,'p-1','d-1','{}',?)`,
        [id, subject.impact ?? null, subject.portfolio ?? null, new Date().toISOString()],
      );
    const dialogCount = (): number =>
      (
        withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM "${TABLE}"`).get()) as {
          n: number;
        }
      ).n;

    let seeded: ReturnType<typeof existing>;

    beforeAll(() => {
      sqlite = createMigratedSqlite("2270-subject-clarification-dialogs-migration", {
        stopBefore: MIGRATION,
      });
      const now = new Date("2026-11-01T00:00:00Z").toISOString();
      sqlite.exec(
        `INSERT INTO "users" ("id","username","displayName","email","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["u-1", "u-1", "U", "u1@example.test", now, now],
      );
      sqlite.exec(
        `INSERT INTO "projects" ("id","name","slug","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["p-1", "P", "p-1", "u-1", now, now],
      );
      insertImpact("ia-1");
      insertAssessment("pa-1");
      seeded = existing();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without the table, with the seeded rows", () => {
      expect(tables()).not.toContain(TABLE);
      expect(seeded.impact_analyses).toHaveLength(1);
      expect(seeded.portfolio_assessments).toHaveLength(1);
    });

    it(
      "up: creates the table and leaves every existing row unchanged",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        expect(tables()).toContain(TABLE);
        expect(existing()).toEqual(seeded);
        expect(dialogCount()).toBe(0);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("is one dialog per run and per check, and a deleted run or check takes its dialog", () => {
      insertImpact("ia-temp");
      insertAssessment("pa-temp");
      insertDialog("sd-1", { impact: "ia-temp" });
      expect(() => insertDialog("sd-2", { impact: "ia-temp" })).toThrow(/UNIQUE/);
      insertDialog("sd-3", { portfolio: "pa-temp" });
      expect(() => insertDialog("sd-4", { portfolio: "pa-temp" })).toThrow(/UNIQUE/);
      expect(dialogCount()).toBe(2);
      withDb((db) => {
        db.pragma("foreign_keys = ON");
        db.exec(`DELETE FROM "impact_analyses" WHERE "id" = 'ia-temp'`);
      });
      expect(dialogCount()).toBe(1);
      withDb((db) => {
        db.pragma("foreign_keys = ON");
        db.exec(`DELETE FROM "portfolio_assessments" WHERE "id" = 'pa-temp'`);
      });
      expect(dialogCount()).toBe(0);
    });

    it("reverse: drops the table, forgets the migration, leaves every other row unchanged", () => {
      insertDialog("sd-5", { impact: "ia-1" });
      withDb((db) => db.exec(ROLLBACK_SQL));
      expect(applied()).toBe(false);
      expect(tables()).not.toContain(TABLE);
      expect(existing()).toEqual(seeded);
    });

    it(
      "up again: `migrate deploy` re-applies it and the rows still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        expect(tables()).toContain(TABLE);
        expect(dialogCount()).toBe(0);
        expect(existing()).toMatchObject(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin is idempotent, and its reverse is the same operation", () => {
      expect(PG_MIGRATION_SQL).toContain(`CREATE TABLE IF NOT EXISTS "${TABLE}"`);
      for (const fk of [
        "subject_clarification_dialogs_impactAnalysisId_fkey",
        "subject_clarification_dialogs_portfolioAssessmentId_fkey",
      ]) {
        expect(PG_MIGRATION_SQL).toContain(
          `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${fk}')`,
        );
      }
      expect(PG_MIGRATION_SQL).toMatch(/REFERENCES "impact_analyses"\("id"\) ON DELETE CASCADE/);
      expect(PG_MIGRATION_SQL).toMatch(
        /REFERENCES "portfolio_assessments"\("id"\) ON DELETE CASCADE/,
      );
      // No other table is touched.
      expect(PG_MIGRATION_SQL).not.toMatch(/ALTER TABLE "(?!subject_clarification_dialogs")/);
      // The cumulative baseline carries it too (the schema parity guard).
      expect(PG_INIT_SQL).toContain(`CREATE TABLE "${TABLE}"`);
      expect(PG_ROLLBACK_SQL).toContain(`DROP TABLE IF EXISTS "${TABLE}"`);
      expect(PG_ROLLBACK_SQL).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
