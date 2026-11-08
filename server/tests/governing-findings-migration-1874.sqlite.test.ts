/**
 * Issue #1874 (epic #1866) — the `governing_findings` table: the migration and
 * its committed reverse script, applied up -> reverse -> up to a SQLite
 * database holding an analysis written BEFORE the migration. Prisma Migrate
 * has no down migrations, so the reverse is a hand-run SQL file
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

const MIGRATION = "20261119001874_issue1874_governing_findings";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1874 — governing findings migration: up -> reverse -> up",
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
    const analyses = () => withDb((db) => db.prepare(`SELECT "id","status" FROM "analyses"`).all());
    const insertFinding = (id: string) =>
      withDb((db) =>
        db
          .prepare(
            `INSERT INTO "governing_findings" ("id","analysisId","requirementId","ruleId","revisionId","revisionLabel","documentTitle","controlId","clauseRef","status","reasoning","updatedAt")
             VALUES (?, 'ana-1', 'REQ-001', 'rule-1', 'rev-1', 'v1', 'Policy', 'EN-03', '§4.3', 'gap', 'r', '2026-11-08T00:00:00.000Z')`,
          )
          .run(id),
      );
    let seeded: unknown;

    beforeAll(() => {
      sqlite = createMigratedSqlite("1874-governing-findings-migration", { stopBefore: MIGRATION });
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "analyses" ("id","projectId","startedById","status","createdAt","updatedAt")
           VALUES ('ana-1','proj-1','u-1','completed','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = analyses();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the empty table; reverse drops it and its rows and leaves analyses alone; up again re-creates it",
      () => {
        expect(tables()).not.toContain("governing_findings");
        sqlite.apply(MIGRATION);
        expect(tables()).toContain("governing_findings");
        insertFinding("gf-1");
        // One finding per (analysis, requirement, rule).
        expect(() => insertFinding("gf-2")).toThrow(/UNIQUE/);
        withDb((db) => db.exec(rollback));
        expect(tables()).not.toContain("governing_findings");
        expect(analyses()).toEqual(seeded);
        sqlite.applyRemaining();
        expect(tables()).toContain("governing_findings");
        expect(
          withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM "governing_findings"`).get()),
        ).toEqual({ n: 0 });
        expect(analyses()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin creates and drops the same table, idempotently", () => {
      expect(pgUp).toMatch(/CREATE TABLE IF NOT EXISTS "governing_findings"/);
      expect(pgUp).toMatch(
        /CREATE UNIQUE INDEX IF NOT EXISTS "governing_findings_analysisId_requirementId_ruleId_key"/,
      );
      expect(pgUp).toMatch(
        /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'governing_findings_analysisId_fkey'\)/,
      );
      expect(pgDown).toMatch(/DROP TABLE IF EXISTS "governing_findings" CASCADE;/);
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
