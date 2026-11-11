/**
 * Issue #2280 — the saved-document-reading migration and its committed reverse
 * script, applied up -> reverse -> up to a SQLite database seeded with rows
 * written BEFORE the migration. Prisma Migrate has no down migrations, so the
 * reverse is a hand-run SQL file (server/prisma/rollbacks/); this proves it
 * works, leaves every pre-existing row as it was at each step, and lets
 * `prisma migrate deploy` apply the migration again afterwards. It also pins the
 * table's key (one row per document, file, reader, model and text) and that a
 * hard-deleted document takes its readings with it.
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

const MIGRATION = "20261123002280_issue2280_saved_document_readings";
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
const TABLE = "saved_document_readings";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2280 — saved document reading migration: up -> reverse -> up",
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
          ["users", "projects", "documents"].map((t) => [
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
    const insertDocument = (id: string, now: string) =>
      sqlite.exec(
        `INSERT INTO "documents" ("id","projectId","filename","mimeType","sizeBytes","storagePath","checksum","uploadedById","uploadedAt")
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, "p-1", `${id}.md`, "text/markdown", 10, `p-1/${id}`, `sum-${id}`, "u-1", now],
      );
    const insertReading = (id: string, documentId: string, model = "claude-sonnet-5-5") =>
      sqlite.exec(
        `INSERT INTO "${TABLE}" ("id","projectId","documentId","checksum","readerVersion","model","textHash","reading","usage")
         VALUES (?,'p-1',?,?,'1',?,'h','{}','{}')`,
        [id, documentId, `sum-${documentId}`, model],
      );

    let seeded: ReturnType<typeof existing>;

    beforeAll(() => {
      sqlite = createMigratedSqlite("2280-saved-document-readings-migration", {
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
      insertDocument("d-1", now);
      seeded = existing();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without the table, with the seeded rows", () => {
      expect(tables()).not.toContain(TABLE);
      expect(seeded.documents).toHaveLength(1);
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

    it("is one row per key, a different model is another row, and a hard-deleted document takes them", () => {
      insertDocument("d-temp", new Date().toISOString());
      insertReading("r-1", "d-temp");
      expect(() => insertReading("r-2", "d-temp")).toThrow(/UNIQUE/);
      insertReading("r-3", "d-temp", "claude-opus-5");
      withDb((db) => {
        db.pragma("foreign_keys = ON");
        db.exec(`DELETE FROM "documents" WHERE "id" = 'd-temp'`);
      });
      expect(withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM "${TABLE}"`).get())).toEqual({
        n: 0,
      });
    });

    it("reverse: drops the table, forgets the migration, leaves every other row unchanged", () => {
      insertReading("r-4", "d-1");
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
        /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'saved_document_readings_documentId_fkey'\)/,
      );
      expect(PG_MIGRATION_SQL).toMatch(/REFERENCES "documents"\("id"\) ON DELETE CASCADE/);
      expect(PG_INIT_SQL).toContain(`CREATE TABLE "${TABLE}"`);
      expect(PG_INIT_SQL).toContain(`ADD CONSTRAINT "saved_document_readings_documentId_fkey"`);
      expect(PG_ROLLBACK_SQL).toContain(`DROP TABLE IF EXISTS "${TABLE}"`);
      expect(PG_ROLLBACK_SQL).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
