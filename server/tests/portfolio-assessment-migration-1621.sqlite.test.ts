/**
 * Issue #1621 — the portfolio assessment migration and its committed reverse
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

const MIGRATION = "20261107001621_issue1621_portfolio_assessment";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const PG_ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const TABLES = [
  "portfolio_assessments",
  "portfolio_assessment_products",
  "portfolio_assessment_repos",
] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1621 — portfolio assessment migration: up -> reverse -> up",
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
    /** Every pre-existing row of the tables the seed wrote, as the database holds them. */
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
      sqlite = createMigratedSqlite("1621-portfolio-migration", { stopBefore: MIGRATION });
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

    it("starts without the tables, with the seeded rows", () => {
      for (const t of TABLES) expect(tables()).not.toContain(t);
      expect(seeded.requirements).toHaveLength(2);
    });

    it(
      "up: creates the three tables and leaves every existing row unchanged",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        for (const t of TABLES) expect(tables()).toContain(t);
        expect(existing()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("deleting a requirement sets an assessment's source to NULL, and an assessment's rows go with it", () => {
      const now = new Date().toISOString();
      sqlite.exec(
        `INSERT INTO "requirements" ("id","projectId","analysisId","type","title","body","priority","labels","createdAt","updatedAt")
         VALUES ('r-temp','p-1','a-1','feature','Temp','b','low','[]',?,?)`,
        [now, now],
      );
      sqlite.exec(
        `INSERT INTO "portfolio_assessments" ("id","statement","sourceRequirementId","scope","createdById","createdAt","updatedAt")
         VALUES ('pa-1','Temp','r-temp','product','u-1',?,?)`,
        [now, now],
      );
      sqlite.exec(
        `INSERT INTO "portfolio_assessment_repos" ("id","assessmentId","productId","repoConnectionId","verdict") VALUES ('par-1','pa-1','prod','rc','partial')`,
      );
      withDb((db) => db.exec(`DELETE FROM "requirements" WHERE "id" = 'r-temp'`));
      expect(
        withDb((db) =>
          db.prepare(`SELECT "sourceRequirementId" FROM "portfolio_assessments"`).get(),
        ),
      ).toEqual({ sourceRequirementId: null });
      withDb((db) => db.exec(`DELETE FROM "portfolio_assessments" WHERE "id" = 'pa-1'`));
      expect(
        withDb((db) => db.prepare(`SELECT COUNT(*) AS n FROM "portfolio_assessment_repos"`).get()),
      ).toEqual({ n: 0 });
    });

    it("reverse: drops the tables, forgets the migration, leaves every other row unchanged", () => {
      // What the reverse loses — and only that: an assessment and its rows.
      const now = new Date().toISOString();
      sqlite.exec(
        `INSERT INTO "portfolio_assessments" ("id","statement","sourceRequirementId","scope","createdById","createdAt","updatedAt")
         VALUES ('pa-2','Export invoices','r-1','product','u-1',?,?)`,
        [now, now],
      );
      sqlite.exec(
        `INSERT INTO "portfolio_assessment_products" ("id","assessmentId","productId","coverage") VALUES ('pap-2','pa-2','prod','covers')`,
      );
      withDb((db) => db.exec(ROLLBACK_SQL));
      expect(applied()).toBe(false);
      for (const t of TABLES) expect(tables()).not.toContain(t);
      expect(existing()).toEqual(seeded);
    });

    it(
      "up again: `migrate deploy` re-applies it and the rows still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        for (const t of TABLES) expect(tables()).toContain(t);
        expect(existing()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres reverse script is the same operation, idempotent", () => {
      for (const t of TABLES)
        expect(PG_ROLLBACK_SQL).toMatch(new RegExp(`DROP TABLE IF EXISTS "${t}"`));
      expect(PG_ROLLBACK_SQL).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
