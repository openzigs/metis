/**
 * Issue #1838 — the similarity-dismissal migration and its committed reverse
 * script, applied up -> reverse -> up to a SQLite database seeded with rows
 * written BEFORE the migration. Prisma Migrate has no down migrations, so the
 * reverse is a hand-run SQL file (server/prisma/rollbacks/); this proves it
 * works, leaves every pre-existing row as it was at each step, and lets
 * `prisma migrate deploy` apply the migration again afterwards.
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

const MIGRATION = "20261114001838_issue1838_requirement_similarity_dismissals";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const PG_ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const PG_MIGRATION_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
  "utf-8",
);
const PG_INIT_SQL = readFileSync(
  path.join(
    SERVER_ROOT,
    "prisma",
    "postgres",
    "migrations",
    "00000000000000_init",
    "migration.sql",
  ),
  "utf-8",
);
const TABLE = "requirement_similarity_dismissals";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1838 — similarity dismissal migration: up -> reverse -> up",
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
          ["users", "projects", "analyses", "requirements"].map((t) => [
            t,
            db.prepare(`SELECT * FROM "${t}" ORDER BY "id"`).all(),
          ]),
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

    let seeded: ReturnType<typeof existing>;

    beforeAll(() => {
      sqlite = createMigratedSqlite("1838-similarity-dismissals-migration", {
        stopBefore: MIGRATION,
      });
      const now = new Date("2026-10-01T00:00:00Z").toISOString();
      sqlite.exec(
        `INSERT INTO "users" ("id","username","displayName","email","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["u-1", "u-1", "U", "u1@example.test", now, now],
      );
      sqlite.exec(
        `INSERT INTO "projects" ("id","name","slug","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["p-1", "P", "p-1", "u-1", now, now],
      );
      sqlite.exec(
        `INSERT INTO "analyses" ("id","projectId","startedById","status","startedAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`,
        ["a-1", "p-1", "u-1", "completed", now, now, now],
      );
      for (const [id, title] of [
        ["r-1", "Export invoices"],
        ["r-2", "Single sign-on"],
      ]) {
        sqlite.exec(
          `INSERT INTO "requirements" ("id","projectId","analysisId","type","title","body","priority","labels","createdAt","updatedAt")
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [id, "p-1", "a-1", "feature", title, `${title} body`, "high", "[]", now, now],
        );
      }
      seeded = existing();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without the table, with the seeded rows", () => {
      expect(tables()).not.toContain(TABLE);
      expect(seeded.requirements).toHaveLength(2);
    });

    it(
      "up: creates the table and leaves every existing row unchanged",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        expect(tables()).toContain(TABLE);
        expect(existing()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("is one row per pair, and goes with either requirement", () => {
      const now = new Date().toISOString();
      sqlite.exec(
        `INSERT INTO "requirements" ("id","projectId","analysisId","type","title","body","priority","labels","createdAt","updatedAt")
         VALUES ('r-temp','p-1','a-1','feature','Temp','b','low','[]',?,?)`,
        [now, now],
      );
      const insert = (id: string) =>
        sqlite.exec(
          `INSERT INTO "${TABLE}" ("id","projectId","requirementId","otherRequirementId","dismissedById") VALUES (?,'p-1','r-1','r-temp','u-1')`,
          [id],
        );
      insert("d-1");
      expect(() => insert("d-2")).toThrow(/UNIQUE/);
      withDb((db) => {
        db.pragma("foreign_keys = ON");
        db.exec(`DELETE FROM "requirements" WHERE "id" = 'r-temp'`);
      });
      expect(withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM "${TABLE}"`).get())).toEqual({
        n: 0,
      });
    });

    it("reverse: drops the table, forgets the migration, leaves every other row unchanged", () => {
      sqlite.exec(
        `INSERT INTO "${TABLE}" ("id","projectId","requirementId","otherRequirementId","dismissedById") VALUES ('d-3','p-1','r-1','r-2','u-1')`,
      );
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
        expect(existing()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin is idempotent, its baseline carries the table, and its reverse is the same operation", () => {
      expect(PG_MIGRATION_SQL).toContain(`CREATE TABLE IF NOT EXISTS "${TABLE}"`);
      expect(PG_MIGRATION_SQL).toMatch(
        /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'requirement_similarity_dismissals_otherRequirementId_fkey'\)/,
      );
      expect(PG_MIGRATION_SQL).toMatch(/REFERENCES "requirements"\("id"\) ON DELETE CASCADE/);
      expect(PG_INIT_SQL).toContain(`CREATE TABLE "${TABLE}"`);
      expect(PG_ROLLBACK_SQL).toContain(`DROP TABLE IF EXISTS "${TABLE}"`);
      expect(PG_ROLLBACK_SQL).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
