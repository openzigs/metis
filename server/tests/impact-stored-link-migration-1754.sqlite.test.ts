/**
 * Issue #1754 — the `impact_analyses.requirementIds` and `impact_items.seedEvidence`
 * migration and its committed reverse script, applied up -> reverse -> up to a
 * SQLite database seeded with a run and an item written BEFORE the migration.
 * Prisma Migrate has no down migrations, so the reverse is a hand-run SQL file
 * (server/prisma/rollbacks/); this proves it works, leaves every pre-existing
 * row as it was at each step, and lets `prisma migrate deploy` apply the
 * migration again afterwards.
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

const MIGRATION = "20261112001754_issue1754_impact_stored_link_seeds";
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

const RUN_COLUMNS = ["id", "status", "sourceText", "summary", "startedById"] as const;
const ITEM_COLUMNS = ["id", "impactAnalysisId", "projectId", "severity", "impactScore"] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1754 — impact stored-link seeds migration: up -> reverse -> up",
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
    const columns = (table: string): string[] =>
      withDb((db) =>
        (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const rows = (table: string, cols: readonly string[]): Array<Record<string, unknown>> =>
      withDb(
        (db) =>
          db
            .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${table}" ORDER BY "id"`)
            .all() as Array<Record<string, unknown>>,
      );
    const original = () => ({
      runs: rows("impact_analyses", RUN_COLUMNS),
      items: rows("impact_items", ITEM_COLUMNS),
    });
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

    let seeded: ReturnType<typeof original>;

    beforeAll(() => {
      sqlite = createMigratedSqlite("1754-stored-link-migration", { stopBefore: MIGRATION });
      const now = new Date("2026-11-01T00:00:00Z").toISOString();
      // The parents (user, project) are not what this migration is about: seed
      // the two rows with foreign keys off rather than build a user and a project.
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "impact_analyses" ("id","status","sourceText","summary","startedById","startedAt","totalImpactedSymbols","createdAt","updatedAt")
           VALUES (?,?,?,?,?,?,?,?,?)`,
        ).run(
          "ia-1",
          "completed",
          "Let customers export orders",
          "Impacted 3 symbol(s).",
          "u-1",
          now,
          3,
          now,
          now,
        );
        db.prepare(
          `INSERT INTO "impact_items" ("id","impactAnalysisId","projectId","severity","impactScore","createdAt")
           VALUES (?,?,?,?,?,?)`,
        ).run("ii-1", "ia-1", "p-1", "high", 0.75, now);
      });
      seeded = original();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without either column, with a pre-existing run and item", () => {
      expect(columns("impact_analyses")).not.toContain("requirementIds");
      expect(columns("impact_items")).not.toContain("seedEvidence");
      expect(seeded.runs).toHaveLength(1);
      expect(seeded.items).toHaveLength(1);
    });

    it(
      "up: adds both columns as null and leaves every existing value unchanged",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        expect(columns("impact_analyses")).toContain("requirementIds");
        expect(columns("impact_items")).toContain("seedEvidence");
        expect(original()).toEqual(seeded);
        expect(rows("impact_analyses", ["requirementIds"])).toEqual([{ requirementIds: null }]);
        expect(rows("impact_items", ["seedEvidence"])).toEqual([{ seedEvidence: null }]);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("reverse: drops both columns, forgets the migration, leaves every row unchanged", () => {
      withDb((db) => {
        db.prepare(
          `UPDATE "impact_analyses" SET "requirementIds" = '["r-1"]' WHERE "id" = 'ia-1'`,
        ).run();
        db.prepare(
          `UPDATE "impact_items" SET "seedEvidence" = '{"storedLinks":{"used":1,"stale":0},"editCandidates":[]}' WHERE "id" = 'ii-1'`,
        ).run();
      });
      withDb((db) => db.exec(ROLLBACK_SQL));
      expect(columns("impact_analyses")).not.toContain("requirementIds");
      expect(columns("impact_items")).not.toContain("seedEvidence");
      expect(applied()).toBe(false);
      expect(original()).toEqual(seeded);
    });

    it(
      "up again: `migrate deploy` re-applies it and the rows still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        expect(columns("impact_analyses")).toContain("requirementIds");
        expect(columns("impact_items")).toContain("seedEvidence");
        expect(original()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin adds and drops the same columns, idempotently", () => {
      expect(PG_MIGRATION_SQL).toMatch(
        /ALTER TABLE "impact_analyses" ADD COLUMN IF NOT EXISTS "requirementIds" TEXT;/,
      );
      expect(PG_MIGRATION_SQL).toMatch(
        /ALTER TABLE "impact_items" ADD COLUMN IF NOT EXISTS "seedEvidence" TEXT;/,
      );
      for (const stmt of [
        /DROP COLUMN IF EXISTS "requirementIds"/,
        /DROP COLUMN IF EXISTS "seedEvidence"/,
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      ]) {
        expect(PG_ROLLBACK_SQL).toMatch(stmt);
      }
    });
  },
);
