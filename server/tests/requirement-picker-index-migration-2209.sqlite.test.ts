/**
 * Issue #2209 — the (`projectId`, `createdAt`, `id`) index on `requirements`, so
 * the discussion requirement picker's read (`searchProjectRequirements`: one
 * project's live requirements, newest first, id as the tie-break, at most 20)
 * walks the index in order instead of sorting the whole project per keystroke.
 * The migration and its committed reverse script, applied up -> reverse -> up
 * to a SQLite database holding a requirement written BEFORE the migration.
 * Prisma Migrate has no down migrations, so the reverse is a hand-run SQL file
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

const MIGRATION = "20261121002209_issue2209_requirement_picker_index";
const INDEX = "requirements_projectId_createdAt_id_idx";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The picker's id read, as `requirement-search.ts` sends it to SQLite. */
const PICKER_READ = `SELECT r."id" FROM "requirements" r
    JOIN "analyses" a ON a."id" = r."analysisId"
    WHERE r."projectId" = ?
      AND r."deletedAt" IS NULL
      AND a."deletedAt" IS NULL
      AND LOWER(r."title") LIKE LOWER(?) ESCAPE '!'
    ORDER BY r."createdAt" DESC, r."id" DESC
    LIMIT 20`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2209 — requirements (projectId, createdAt, id) index migration: up -> reverse -> up",
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
    const indexes = () =>
      withDb((db) =>
        (db.prepare(`PRAGMA index_list("requirements")`).all() as Array<{ name: string }>)
          .map((i) => i.name)
          .sort(),
      );
    const plan = () =>
      withDb((db) =>
        (
          db.prepare(`EXPLAIN QUERY PLAN ${PICKER_READ}`).all("p-1", "%feeds%") as Array<{
            detail: string;
          }>
        )
          .map((r) => r.detail)
          .join("\n"),
      );
    const rows = () =>
      withDb((db) => db.prepare(`SELECT * FROM "requirements" ORDER BY "id"`).all());
    let seeded: unknown;
    let indexesBefore: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2209-requirement-picker-index-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        db.prepare(
          `INSERT INTO "users" ("id","username","displayName","email","updatedAt")
           VALUES ('u-1','u-1','U','u@x.test','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "projects" ("id","name","slug","createdById","updatedAt")
           VALUES ('p-1','P','p-1','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "analyses" ("id","projectId","updatedAt") VALUES ('a-1','p-1','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "requirements" ("id","projectId","analysisId","title","body","updatedAt")
           VALUES ('r-1','p-1','a-1','Refresh feeds on a schedule','b','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = rows();
      indexesBefore = indexes();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the index and the picker read walks it in order; reverse drops it; up again re-applies",
      () => {
        expect(indexesBefore).not.toContain(INDEX);
        expect(plan()).not.toContain(INDEX);

        sqlite.apply(MIGRATION);
        expect(indexes()).toEqual([...indexesBefore, INDEX].sort());
        expect(plan()).toContain(`USING INDEX ${INDEX}`);
        // Newest first straight off the index: no sort of the project's rows.
        expect(plan()).not.toContain("TEMP B-TREE");
        expect(rows()).toEqual(seeded);

        withDb((db) => db.exec(rollback));
        expect(indexes()).toEqual(indexesBefore);
        expect(rows()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(indexes()).toContain(INDEX);
        expect(rows()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toMatch(
        new RegExp(
          `CREATE INDEX IF NOT EXISTS "${INDEX}" ON "requirements"\\("projectId", "createdAt", "id"\\);`,
        ),
      );
      expect(pgDown).toMatch(new RegExp(`DROP INDEX IF EXISTS "${INDEX}";`));
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
