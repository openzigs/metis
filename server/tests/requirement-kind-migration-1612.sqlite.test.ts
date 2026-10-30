/**
 * Issue #1612 — the `kind` / `nfrCategory` migration and its committed reverse
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

const MIGRATION = "20261105001612_issue1612_requirement_kind";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const PG_ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);

/** The columns every pre-existing row had before the migration. */
const ORIGINAL_COLUMNS = [
  "id",
  "projectId",
  "analysisId",
  "type",
  "title",
  "body",
  "priority",
  "labels",
  "storyPoints",
  "reviewStatus",
  "coverage",
  "verdict",
  "acceptanceCriteria",
  "version",
] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1612 — requirement kind migration: up -> reverse -> up",
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
        (db.prepare(`PRAGMA table_info("requirements")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const original = (): Array<Record<string, unknown>> =>
      withDb(
        (db) =>
          db
            .prepare(
              `SELECT ${ORIGINAL_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "requirements" ORDER BY "id"`,
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
      sqlite = createMigratedSqlite("1612-kind-migration", { stopBefore: MIGRATION });
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
      const rows: Array<[string, string, string, string | null, string | null, number]> = [
        ["r-1", "bug", "Plain row", null, null, 0],
        ["r-2", "feature", "Verdict and criteria", "implemented", '["a","b"]', 3],
        ["r-3", "task", "Reviewed row", "gap-confirmed", "[]", 1],
      ];
      for (const [id, type, title, verdict, criteria, version] of rows) {
        sqlite.exec(
          `INSERT INTO "requirements" ("id","projectId","analysisId","type","title","body","priority","labels","storyPoints","reviewStatus","coverage","verdict","acceptanceCriteria","version","createdAt","updatedAt")
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            "p-1",
            "a-1",
            type,
            title,
            `${title} body`,
            "high",
            '["x"]',
            version === 3 ? 5 : null,
            version === 1 ? "approved" : null,
            verdict ? "grounded_in_code" : null,
            verdict,
            criteria ?? "[]",
            version,
            now,
            now,
          ],
        );
      }
      seeded = original();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without the columns, with three pre-existing rows", () => {
      expect(columns()).not.toContain("kind");
      expect(columns()).not.toContain("nfrCategory");
      expect(seeded).toHaveLength(3);
    });

    it(
      "up: adds both columns as NULL and leaves every existing value unchanged",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        expect(columns()).toEqual(expect.arrayContaining(["kind", "nfrCategory"]));
        expect(original()).toEqual(seeded);
        const added = withDb(
          (db) => db.prepare(`SELECT "kind", "nfrCategory" FROM "requirements"`).all() as unknown[],
        );
        expect(added).toEqual([
          { kind: null, nfrCategory: null },
          { kind: null, nfrCategory: null },
          { kind: null, nfrCategory: null },
        ]);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("reverse: drops both columns, forgets the migration, leaves every row unchanged", () => {
      // A value set while migrated is what the reverse loses — and only that.
      sqlite.exec(`UPDATE "requirements" SET "kind" = 'functional' WHERE "id" = 'r-1'`);
      withDb((db) => db.exec(ROLLBACK_SQL));
      expect(columns()).not.toContain("kind");
      expect(columns()).not.toContain("nfrCategory");
      expect(applied()).toBe(false);
      expect(original()).toEqual(seeded);
    });

    it(
      "up again: `migrate deploy` re-applies it and the rows still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        expect(columns()).toEqual(expect.arrayContaining(["kind", "nfrCategory"]));
        expect(original()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres reverse script is the same operation, idempotent", () => {
      for (const stmt of [
        /DROP COLUMN IF EXISTS "nfrCategory"/,
        /DROP COLUMN IF EXISTS "kind"/,
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      ]) {
        expect(PG_ROLLBACK_SQL).toMatch(stmt);
      }
    });
  },
);
