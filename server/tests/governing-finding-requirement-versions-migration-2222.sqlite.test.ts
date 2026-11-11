/**
 * Issue #2222 — `governing_findings.requirementVersions`: the requirement
 * versions a re-checked finding judged. The migration and its committed reverse
 * script, applied up -> reverse -> up to a SQLite database holding a finding
 * written BEFORE the migration. Prisma Migrate has no down migrations, so the
 * reverse is a hand-run SQL file (server/prisma/rollbacks/).
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

const MIGRATION = "20261123002222_issue2222_governing_finding_requirement_versions";
const COLUMN = "requirementVersions";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#2222 — governing_findings.requirementVersions: up -> reverse -> up",
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
          db.prepare(`PRAGMA table_info("governing_findings")`).all() as Array<{ name: string }>
        ).map((c) => c.name),
      );
    const finding = () =>
      withDb(
        (db) =>
          db.prepare(`SELECT * FROM "governing_findings" WHERE "id" = 'gf-1'`).get() as Record<
            string,
            unknown
          >,
      );
    let seeded: Record<string, unknown>;

    beforeAll(() => {
      sqlite = createMigratedSqlite("2222-governing-finding-requirement-versions", {
        stopBefore: MIGRATION,
      });
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "analyses" ("id","projectId","startedById","status","createdAt","updatedAt")
           VALUES ('ana-1','proj-1','u-1','completed','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z')`,
        ).run();
        db.prepare(
          `INSERT INTO "governing_findings" ("id","analysisId","requirementId","ruleId","revisionId","revisionLabel","documentTitle","controlId","clauseRef","status","reasoning","updatedAt")
           VALUES ('gf-1', 'ana-1', 'AC-2', 'rule-1', 'rev-1', 'v1', 'Policy', 'PW-01', '§4.3', 'gap', 'r', '2026-11-08T00:00:00.000Z')`,
        ).run();
      });
      seeded = finding();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the column, null on an existing finding; reverse drops it and keeps the row; up again adds it",
      () => {
        expect(columns()).not.toContain(COLUMN);

        sqlite.apply(MIGRATION);
        expect(columns()).toContain(COLUMN);
        expect(finding()).toEqual({ ...seeded, [COLUMN]: null });
        withDb((db) =>
          db
            .prepare(`UPDATE "governing_findings" SET "${COLUMN}" = ? WHERE "id" = 'gf-1'`)
            .run(JSON.stringify({ "req-1": 2 })),
        );
        expect(finding()[COLUMN]).toBe('{"req-1":2}');

        withDb((db) => db.exec(rollback));
        expect(columns()).not.toContain(COLUMN);
        expect(finding()).toEqual(seeded);

        sqlite.applyRemaining();
        expect(columns()).toContain(COLUMN);
        expect(finding()).toEqual({ ...seeded, [COLUMN]: null });
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin adds and drops the same column, idempotently", () => {
      expect(pgUp).toMatch(
        new RegExp(`ALTER TABLE "governing_findings" ADD COLUMN IF NOT EXISTS "${COLUMN}" TEXT;`),
      );
      expect(pgDown).toMatch(
        new RegExp(`ALTER TABLE "governing_findings" DROP COLUMN IF EXISTS "${COLUMN}";`),
      );
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
