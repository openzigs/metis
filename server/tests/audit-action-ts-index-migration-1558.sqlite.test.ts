/**
 * Issue #1558 — the (`action`, `ts`) index on `audit_logs`, so the admin SAML
 * group-overage warning's read (`samlGroupOverageSummary`: one action, newest
 * first, in a time window) seeks instead of scanning the table.
 * The migration and its committed reverse script, applied up -> reverse -> up
 * to a SQLite database holding an audit row written BEFORE the migration.
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

const MIGRATION = "20261120001558_issue1558_audit_action_ts_index";
const INDEX = "audit_logs_action_ts_idx";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The overage summary's read, as Prisma sends it to SQLite. */
const OVERAGE_READ = `SELECT "id" FROM "audit_logs" WHERE "action" = ? AND "ts" >= ? ORDER BY "ts" DESC LIMIT 20`;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1558 — audit_logs (action, ts) index migration: up -> reverse -> up",
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
        (db.prepare(`PRAGMA index_list("audit_logs")`).all() as Array<{ name: string }>)
          .map((i) => i.name)
          .sort(),
      );
    const plan = () =>
      withDb((db) =>
        (
          db
            .prepare(`EXPLAIN QUERY PLAN ${OVERAGE_READ}`)
            .all("sso.saml.group_overage", "2026-10-11T00:00:00.000Z") as Array<{
            detail: string;
          }>
        )
          .map((r) => r.detail)
          .join("\n"),
      );
    const rows = () => withDb((db) => db.prepare(`SELECT * FROM "audit_logs" ORDER BY "id"`).all());
    let seeded: unknown;
    let indexesBefore: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("1558-audit-action-ts-index-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        db.prepare(
          `INSERT INTO "audit_logs" ("id","actorId","action","targetType","targetId","metadata","ts")
           VALUES ('al-1',NULL,'sso.saml.group_overage','user','u-1','{"role":"reader"}','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = rows();
      indexesBefore = indexes();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the index and the overage read uses it; reverse drops it; up again re-applies",
      () => {
        expect(indexesBefore).not.toContain(INDEX);
        expect(plan()).not.toContain(INDEX);

        sqlite.apply(MIGRATION);
        expect(indexes()).toEqual([...indexesBefore, INDEX].sort());
        expect(plan()).toContain(`USING INDEX ${INDEX}`);
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
        new RegExp(`CREATE INDEX IF NOT EXISTS "${INDEX}" ON "audit_logs"\\("action", "ts"\\);`),
      );
      expect(pgDown).toMatch(new RegExp(`DROP INDEX IF EXISTS "${INDEX}";`));
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
