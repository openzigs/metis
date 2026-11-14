/**
 * Issue #2218 — the (`projectId`) index on `requirements` is dropped: #2209's
 * (`projectId`, `createdAt`, `id`) index has it as a prefix and serves the same
 * reads. The migration and its committed reverse script, applied
 * up -> reverse -> up to a SQLite database holding a requirement written BEFORE
 * the migration. Prisma Migrate has no down migrations, so the reverse is a
 * hand-run SQL file (server/prisma/rollbacks/).
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

const MIGRATION = "20261122002218_issue2218_drop_requirement_project_index";
const DROPPED = "requirements_projectId_idx";
const COMPOSITE = "requirements_projectId_createdAt_id_idx";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A read by project alone, as the requirement list and the counts send it. */
const BY_PROJECT = `SELECT "id", "title" FROM "requirements" WHERE "projectId" = ?`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2218 — drop the requirements (projectId) index: up -> reverse -> up",
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
        (db.prepare(`EXPLAIN QUERY PLAN ${BY_PROJECT}`).all("p-1") as Array<{ detail: string }>)
          .map((r) => r.detail)
          .join("\n"),
      );
    const rows = () =>
      withDb((db) => db.prepare(`SELECT * FROM "requirements" ORDER BY "id"`).all());
    let seeded: unknown;
    let indexesBefore: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2218-requirement-project-index-drop", {
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
      "up drops the index and a read by project walks the composite; reverse restores it; up again drops it",
      () => {
        expect(indexesBefore).toContain(DROPPED);
        expect(indexesBefore).toContain(COMPOSITE);

        sqlite.apply(MIGRATION);
        expect(indexes()).toEqual(indexesBefore.filter((i) => i !== DROPPED));
        expect(plan()).toContain(COMPOSITE);
        expect(rows()).toEqual(seeded);

        withDb((db) => db.exec(rollback));
        expect(indexes()).toEqual(indexesBefore);
        expect(rows()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(indexes()).not.toContain(DROPPED);
        // A later migration may add a column of its own (#2446: `sourceIds`).
        expect(
          onSeededColumns({ requirements: rows() }, { requirements: seeded as unknown[] }),
        ).toEqual({ requirements: seeded });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      expect(pgUp).toMatch(new RegExp(`DROP INDEX IF EXISTS "${DROPPED}";`));
      expect(pgDown).toMatch(
        new RegExp(`CREATE INDEX IF NOT EXISTS "${DROPPED}" ON "requirements"\\("projectId"\\);`),
      );
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
