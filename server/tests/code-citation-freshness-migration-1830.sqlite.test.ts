/**
 * Issue #1830 — the `requirement_code_mappings` version-stamp migration and its
 * committed reverse script, applied up -> reverse -> up to a SQLite database
 * seeded with code links written BEFORE the migration. Prisma Migrate has no
 * down migrations, so the reverse is a hand-run SQL file
 * (server/prisma/rollbacks/); this proves it works, returns the table to its
 * prior shape with every pre-existing row as it was, and lets `prisma migrate
 * deploy` apply the migration again afterwards. A pre-migration row reads
 * `freshness = 'unverified'`, never `fresh`: nothing has checked it.
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

const MIGRATION = "20261113001830_issue1830_code_citation_freshness";
const TABLE = "requirement_code_mappings";
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

const NEW_COLUMNS = [
  "codeGraphId",
  "commitSha",
  "freshness",
  "validatedAt",
  "previousFilePath",
  "previousStartLine",
  "previousEndLine",
  "staleReason",
] as const;
const OLD_COLUMNS = [
  "id",
  "requirementId",
  "projectId",
  "codeSymbolId",
  "filePath",
  "startLine",
  "endLine",
  "confidence",
  "source",
  "createdAt",
] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1830 — code citation version-stamp migration: up -> reverse -> up",
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
        (db.prepare(`PRAGMA table_info("${TABLE}")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const indexes = (): string[] =>
      withDb((db) =>
        (db.prepare(`PRAGMA index_list("${TABLE}")`).all() as Array<{ name: string }>)
          .map((i) => i.name)
          .sort(),
      );
    const foreignKeys = (): string[] =>
      withDb((db) =>
        (
          db.prepare(`PRAGMA foreign_key_list("${TABLE}")`).all() as Array<{
            from: string;
            table: string;
            on_delete: string;
          }>
        )
          .map((f) => `${f.from}->${f.table}:${f.on_delete}`)
          .sort(),
      );
    const rows = (cols: readonly string[]): Array<Record<string, unknown>> =>
      withDb(
        (db) =>
          db
            .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM "${TABLE}" ORDER BY "id"`)
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

    let seeded: Array<Record<string, unknown>>;
    let shapeBefore: { columns: string[]; indexes: string[]; foreignKeys: string[] };

    beforeAll(() => {
      sqlite = createMigratedSqlite("1830-citation-freshness-migration", { stopBefore: MIGRATION });
      const now = new Date("2026-11-01T00:00:00Z").toISOString();
      // The parents (requirement, project, symbol) are not what this migration
      // is about: seed the links with foreign keys off.
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        const insert = db.prepare(
          `INSERT INTO "${TABLE}" ("id","requirementId","projectId","codeSymbolId","filePath","startLine","endLine","confidence","source","createdAt")
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        );
        insert.run(
          "m-1",
          "r-1",
          "p-1",
          "s-1",
          "src/auth.ts",
          5,
          20,
          0.8,
          "analysis-grounding",
          now,
        );
        insert.run("m-2", "r-1", "p-1", null, "src/users.ts", null, null, 0.9, "manual", now);
        insert.run("m-3", "r-2", "p-1", null, "src/x.ts", 1, 4, 0.6, "semantic", now);
      });
      seeded = rows(OLD_COLUMNS);
      shapeBefore = { columns: columns(), indexes: indexes(), foreignKeys: foreignKeys() };
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without the #1830 columns, with three pre-existing links", () => {
      for (const c of NEW_COLUMNS) expect(shapeBefore.columns).not.toContain(c);
      expect(seeded).toHaveLength(3);
    });

    it(
      "up: adds the columns; every existing link reads unverified, never fresh, and keeps its values",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        expect(columns()).toEqual([...shapeBefore.columns, ...NEW_COLUMNS]);
        expect(indexes()).toContain("requirement_code_mappings_codeGraphId_idx");
        expect(foreignKeys()).toContain("codeGraphId->code_graphs:SET NULL");
        expect(rows(OLD_COLUMNS)).toEqual(seeded);
        const stamped = rows(["id", ...NEW_COLUMNS]);
        expect(stamped.map((r) => r.freshness)).toEqual(["unverified", "unverified", "unverified"]);
        for (const r of stamped) {
          for (const c of NEW_COLUMNS.filter((n) => n !== "freshness")) expect(r[c]).toBeNull();
        }
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("reverse: the table returns to its prior shape, the migration is forgotten, rows intact", () => {
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `UPDATE "${TABLE}" SET "codeGraphId" = 'g-1', "commitSha" = 'abc1234', "freshness" = 'moved',
             "validatedAt" = '2026-11-02T00:00:00.000Z', "previousFilePath" = 'src/old.ts',
             "previousStartLine" = 1, "previousEndLine" = 9, "staleReason" = NULL WHERE "id" = 'm-1'`,
        ).run();
      });
      withDb((db) => db.exec(ROLLBACK_SQL));
      expect(applied()).toBe(false);
      expect(columns()).toEqual(shapeBefore.columns);
      expect(indexes()).toEqual(shapeBefore.indexes);
      expect(foreignKeys()).toEqual(shapeBefore.foreignKeys);
      expect(rows(OLD_COLUMNS)).toEqual(seeded);
      // The rebuild left no foreign key pointing at a renamed-away table.
      expect(
        withDb((db) =>
          (db.prepare(`PRAGMA foreign_key_list("${TABLE}")`).all() as Array<{ table: string }>)
            .map((f) => f.table)
            .sort(),
        ),
      ).toEqual(["code_symbols", "projects", "requirements"]);
    });

    it(
      "up again: `migrate deploy` re-applies it and the rows still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        expect(columns()).toEqual(expect.arrayContaining([...NEW_COLUMNS]));
        expect(rows(OLD_COLUMNS)).toEqual(seeded);
        expect(rows(["freshness"])).toEqual([
          { freshness: "unverified" },
          { freshness: "unverified" },
          { freshness: "unverified" },
        ]);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin adds and drops the same columns, foreign key and index, idempotently", () => {
      for (const c of NEW_COLUMNS) {
        expect(PG_MIGRATION_SQL).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${c}"`));
        expect(PG_ROLLBACK_SQL).toMatch(new RegExp(`DROP COLUMN IF EXISTS "${c}";`));
      }
      expect(PG_MIGRATION_SQL).toMatch(
        /ADD COLUMN IF NOT EXISTS "freshness" TEXT NOT NULL DEFAULT 'unverified'/,
      );
      expect(PG_MIGRATION_SQL).toMatch(
        /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'requirement_code_mappings_codeGraphId_fkey'\)/,
      );
      expect(PG_MIGRATION_SQL).toMatch(/REFERENCES "code_graphs"\("id"\) ON DELETE SET NULL/);
      expect(PG_ROLLBACK_SQL).toMatch(
        /DROP CONSTRAINT IF EXISTS "requirement_code_mappings_codeGraphId_fkey"/,
      );
      expect(PG_ROLLBACK_SQL).toMatch(
        /DROP INDEX IF EXISTS "requirement_code_mappings_codeGraphId_idx"/,
      );
      expect(PG_ROLLBACK_SQL).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
