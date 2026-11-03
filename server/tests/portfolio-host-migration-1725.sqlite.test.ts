/**
 * Issue #1725 — the `portfolio_assessments.hostProductId` migration and its committed
 * reverse script, applied up -> reverse -> up to a SQLite database seeded with
 * assessments written BEFORE the migration. Prisma Migrate has no down
 * migrations, so the reverse is a hand-run SQL file (server/prisma/rollbacks/);
 * this proves it works, leaves every pre-existing row as it was at each step,
 * and lets `prisma migrate deploy` apply the migration again afterwards.
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

const MIGRATION = "20261111001725_issue1725_portfolio_host_product";
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

/** The columns every pre-existing row had before the migration. */
const ORIGINAL_COLUMNS = [
  "id",
  "statement",
  "scope",
  "productIds",
  "status",
  "portfolioVerdict",
  "summary",
  "report",
  "costUsd",
  "createdById",
] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1725 — portfolio host product migration: up -> reverse -> up",
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
    const columns = (): string[] =>
      withDb((db) =>
        (
          db.prepare(`PRAGMA table_info("portfolio_assessments")`).all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
    const original = (): Array<Record<string, unknown>> =>
      withDb(
        (db) =>
          db
            .prepare(
              `SELECT ${ORIGINAL_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "portfolio_assessments" ORDER BY "id"`,
            )
            .all() as Array<Record<string, unknown>>,
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

    let seeded: Array<Record<string, unknown>> = [];

    beforeAll(() => {
      sqlite = createMigratedSqlite("1725-host-migration", { stopBefore: MIGRATION });
      const now = new Date("2026-10-01T00:00:00Z").toISOString();
      for (const [id, status, verdict, summary] of [
        ["pa-1", "completed", "partial", "Partly covered by Orders."],
        ["pa-2", "pending", null, ""],
      ] as const) {
        sqlite.exec(
          `INSERT INTO "portfolio_assessments" ("id","statement","scope","productIds","status","portfolioVerdict","summary","report","costUsd","createdById","createdAt","updatedAt")
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            `Statement ${id}`,
            "all-accessible",
            '["p1"]',
            status,
            verdict,
            summary,
            '{"source":"template"}',
            0.25,
            "u-1",
            now,
            now,
          ],
        );
      }
      seeded = original();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without the column, with two pre-existing rows", () => {
      expect(columns()).not.toContain("hostProductId");
      expect(seeded).toHaveLength(2);
    });

    it(
      "up: adds the column as null (no host chosen) and leaves every existing value unchanged",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        expect(columns()).toContain("hostProductId");
        expect(original()).toEqual(seeded);
        const added = withDb(
          (db) =>
            db.prepare(`SELECT "hostProductId" FROM "portfolio_assessments"`).all() as unknown[],
        );
        expect(added).toEqual([{ hostProductId: null }, { hostProductId: null }]);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("reverse: drops the column, forgets the migration, leaves every row unchanged", () => {
      // A host written while migrated is what the reverse loses — and only that.
      sqlite.exec(`UPDATE "portfolio_assessments" SET "hostProductId" = 'p1' WHERE "id" = 'pa-1'`);
      withDb((db) => db.exec(ROLLBACK_SQL));
      expect(columns()).not.toContain("hostProductId");
      expect(applied()).toBe(false);
      expect(original()).toEqual(seeded);
    });

    it(
      "up again: `migrate deploy` re-applies it and the rows still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        expect(columns()).toContain("hostProductId");
        expect(original()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin adds and drops the same column, idempotently", () => {
      expect(PG_MIGRATION_SQL).toMatch(/ADD COLUMN IF NOT EXISTS "hostProductId" TEXT;/);
      for (const stmt of [
        /DROP COLUMN IF EXISTS "hostProductId"/,
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      ]) {
        expect(PG_ROLLBACK_SQL).toMatch(stmt);
      }
    });
  },
);
