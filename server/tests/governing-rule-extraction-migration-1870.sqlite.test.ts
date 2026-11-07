/**
 * Issue #1870 (epic #1866) — the revision's `extractionError` and
 * `droppedUnverified` columns: the migration and its committed reverse script,
 * applied up -> reverse -> up to a SQLite database holding a revision written
 * BEFORE the migration. Prisma Migrate has no down migrations, so the reverse
 * is a hand-run SQL file (server/prisma/rollbacks/).
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

const MIGRATION = "20261117001870_issue1870_governing_rule_extraction";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1870 — governing rule-extraction columns migration: up -> reverse -> up",
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
          db.prepare(`PRAGMA table_info("governing_document_revisions")`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
    const SEEDED_COLUMNS = `"id","documentId","revisionLabel","extractedText","indexState","extractionState"`;
    const row = () =>
      withDb((db) =>
        db.prepare(`SELECT ${SEEDED_COLUMNS} FROM "governing_document_revisions"`).all(),
      );
    let seeded: unknown;
    let before: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("1870-rule-extraction-migration", { stopBefore: MIGRATION });
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "governing_document_revisions" ("id","documentId","revisionLabel","effectiveDate","storagePath","contentHash","mimeType","sizeBytes","extractedText","indexState","extractionState","uploadedById","createdAt")
           VALUES ('rev-1','doc-1','v1','2026-01-01T00:00:00.000Z','governing-ws/abc','abc','text/markdown',10,'Policy text','indexed','done','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = row();
      before = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the two columns with null and 0 on existing rows; reverse restores the shape; up again re-applies",
      () => {
        expect(before).not.toContain("extractionError");
        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...before, "extractionError", "droppedUnverified"]);
        expect(row()).toEqual(seeded);
        expect(
          withDb((db) =>
            db
              .prepare(
                `SELECT "extractionError","droppedUnverified" FROM "governing_document_revisions"`,
              )
              .get(),
          ),
        ).toEqual({ extractionError: null, droppedUnverified: 0 });
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(before);
        expect(row()).toEqual(seeded);
        sqlite.applyRemaining();
        expect(columns()).toEqual(expect.arrayContaining(["extractionError", "droppedUnverified"]));
        expect(row()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin adds and drops the same columns, idempotently", () => {
      expect(pgUp).toMatch(/ADD COLUMN IF NOT EXISTS "extractionError" TEXT;/);
      expect(pgUp).toMatch(
        /ADD COLUMN IF NOT EXISTS "droppedUnverified" INTEGER NOT NULL DEFAULT 0;/,
      );
      expect(pgDown).toMatch(/DROP COLUMN IF EXISTS "extractionError";/);
      expect(pgDown).toMatch(/DROP COLUMN IF EXISTS "droppedUnverified";/);
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
