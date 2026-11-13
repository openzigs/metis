/**
 * Issue #2345 — `impact_analyses.sourceAnalysisId`,
 * `portfolio_assessments.sourceAnalysisId` and `portfolio_assessments.preApproval`.
 * The migration and its committed reverse script, applied up -> reverse -> up
 * to a SQLite database holding an impact analysis and a portfolio check written
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

const MIGRATION = "20261126002345_issue2345_change_request_checks";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2345 — change request checks migration: up -> reverse -> up",
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
    const columns = (table: string) =>
      withDb((db) =>
        (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const indexes = (table: string) =>
      withDb((db) =>
        (db.prepare(`PRAGMA index_list("${table}")`).all() as Array<{ name: string }>).map(
          (i) => i.name,
        ),
      );
    const row = (table: string, id: string) =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "${table}" WHERE "id" = ?`).get(id) as Record<string, unknown>,
      );
    let seededImpact: Record<string, unknown>;
    let seededCheck: Record<string, unknown>;
    let impactBefore: string[];
    let checkBefore: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("2345-change-request-checks-migration", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        // The run's starter is not seeded: only the columns are under test.
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "impact_analyses" ("id","status","startedById","updatedAt")
           VALUES ('ia-1','completed','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "portfolio_assessments" ("id","statement","scope","productIds","status","createdById","updatedAt")
           VALUES ('pa-1','Reset by email','product','["p-1"]','completed','u-1','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seededImpact = row("impact_analyses", "ia-1");
      seededCheck = row("portfolio_assessments", "pa-1");
      impactBefore = columns("impact_analyses");
      checkBefore = columns("portfolio_assessments");
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the columns and indexes (existing rows name no change request and are not pre-approval); reverse drops them; up again re-applies",
      () => {
        expect(impactBefore).not.toContain("sourceAnalysisId");
        expect(checkBefore).not.toContain("sourceAnalysisId");
        expect(checkBefore).not.toContain("preApproval");

        sqlite.apply(MIGRATION);
        expect(columns("impact_analyses")).toEqual([...impactBefore, "sourceAnalysisId"]);
        expect(columns("portfolio_assessments")).toEqual([
          ...checkBefore,
          "sourceAnalysisId",
          "preApproval",
        ]);
        expect(indexes("impact_analyses")).toContain("impact_analyses_sourceAnalysisId_idx");
        expect(indexes("portfolio_assessments")).toContain(
          "portfolio_assessments_sourceAnalysisId_idx",
        );
        expect(row("impact_analyses", "ia-1")).toEqual({ ...seededImpact, sourceAnalysisId: null });
        expect(row("portfolio_assessments", "pa-1")).toEqual({
          ...seededCheck,
          sourceAnalysisId: null,
          preApproval: 0,
        });

        // What a change request launch wrote after the migration is lost by the
        // reverse, which the rollback's header says; every other column survives.
        withDb((db) => {
          db.prepare(`UPDATE "impact_analyses" SET "sourceAnalysisId" = 'cr-1'`).run();
          db.prepare(
            `UPDATE "portfolio_assessments" SET "sourceAnalysisId" = 'cr-1', "preApproval" = 1`,
          ).run();
        });
        withDb((db) => db.exec(rollback));
        expect(columns("impact_analyses")).toEqual(impactBefore);
        expect(columns("portfolio_assessments")).toEqual(checkBefore);
        expect(indexes("impact_analyses")).not.toContain("impact_analyses_sourceAnalysisId_idx");
        expect(row("impact_analyses", "ia-1")).toEqual(seededImpact);
        expect(row("portfolio_assessments", "pa-1")).toEqual(seededCheck);

        sqlite.applyRemaining();
        expect(columns("impact_analyses")).toContain("sourceAnalysisId");
        expect(columns("portfolio_assessments")).toContain("preApproval");
        expect(row("portfolio_assessments", "pa-1")).toMatchObject({
          sourceAnalysisId: null,
          preApproval: 0,
        });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin makes the same change and its reverse, idempotently", () => {
      for (const table of ["impact_analyses", "portfolio_assessments"]) {
        expect(pgUp).toContain(
          `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "sourceAnalysisId" TEXT;`,
        );
        expect(pgUp).toContain(
          `CREATE INDEX IF NOT EXISTS "${table}_sourceAnalysisId_idx" ON "${table}"("sourceAnalysisId");`,
        );
        expect(pgDown).toContain(
          `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "sourceAnalysisId";`,
        );
        expect(pgDown).toContain(`DROP INDEX IF EXISTS "${table}_sourceAnalysisId_idx";`);
      }
      expect(pgUp).toContain(
        `ALTER TABLE "portfolio_assessments" ADD COLUMN IF NOT EXISTS "preApproval" BOOLEAN NOT NULL DEFAULT false;`,
      );
      expect(pgDown).toContain(
        `ALTER TABLE "portfolio_assessments" DROP COLUMN IF EXISTS "preApproval";`,
      );
      expect(pgDown).toContain(
        `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`,
      );
    });
  },
);
