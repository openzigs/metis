/**
 * Issue #1687 — the migration that keeps detection's classification of an
 * overridden product edge, and its committed reverse script, applied
 * up -> reverse -> up to a SQLite database seeded with edges written BEFORE the
 * migration. Prisma Migrate has no down migrations, so the reverse is a hand-run
 * SQL file (server/prisma/rollbacks/); this proves it works, leaves every
 * pre-existing edge as it was at each step, and lets `prisma migrate deploy`
 * apply the migration again afterwards.
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

const MIGRATION = "20261110001687_issue1687_product_edge_detected_classification";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const PG_MIGRATION_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
  "utf-8",
);
const PG_ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);

const NEW_COLUMNS = ["detectedIntegrationKind", "detectedStrength", "detectedDirection"] as const;

/** The columns every edge had before the migration. */
const ORIGINAL_COLUMNS = [
  "id",
  "productId",
  "sourceRepoId",
  "targetRepoId",
  "edgeType",
  "confidence",
  "evidence",
  "integrationKind",
  "strength",
  "direction",
  "origin",
  "declaredById",
  "createdAt",
  "updatedAt",
] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1687 — product edge detected-classification migration: up -> reverse -> up",
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
        (db.prepare(`PRAGMA table_info("product_edges")`).all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    const original = (): Array<Record<string, unknown>> =>
      withDb(
        (db) =>
          db
            .prepare(
              `SELECT ${ORIGINAL_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "product_edges" ORDER BY "id"`,
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
      sqlite = createMigratedSqlite("1687-edge-migration", { stopBefore: MIGRATION });
      const now = new Date("2026-10-01T00:00:00Z").toISOString();
      sqlite.exec(
        `INSERT INTO "users" ("id","username","displayName","email","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["u-1", "u-1", "U", "u1@example.test", now, now],
      );
      sqlite.exec(
        `INSERT INTO "projects" ("id","name","slug","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["p-1", "P", "p-1", "u-1", now, now],
      );
      for (const id of ["rc-1", "rc-2"]) {
        sqlite.exec(
          `INSERT INTO "repo_connections" ("id","projectId","label","createdAt","updatedAt") VALUES (?,?,?,?,?)`,
          [id, "p-1", id, now, now],
        );
      }
      sqlite.exec(
        `INSERT INTO "products" ("id","name","slug","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["prod-1", "Product", "prod-1", "u-1", now, now],
      );
      const rows: Array<[string, string, string | null, string]> = [
        ["e-1", "detected", "contract", "api"],
        ["e-2", "overridden", "intrusive", "database"],
        ["e-3", "declared", "functional", "identity"],
      ];
      for (const [id, origin, strength, kind] of rows) {
        sqlite.exec(
          `INSERT INTO "product_edges" ("id","productId","sourceRepoId","targetRepoId","edgeType","confidence","evidence","integrationKind","strength","direction","origin","declaredById","createdAt","updatedAt")
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            "prod-1",
            "rc-1",
            "rc-2",
            "calls",
            0.9,
            "[]",
            kind,
            strength,
            "consumes",
            origin,
            origin === "detected" ? null : "u-1",
            now,
            now,
          ],
        );
      }
      seeded = original();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts without the columns, with three pre-existing edges", () => {
      for (const c of NEW_COLUMNS) expect(columns()).not.toContain(c);
      expect(seeded).toHaveLength(3);
    });

    it(
      "up: adds the three columns as NULL and leaves every existing value unchanged",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        expect(columns()).toEqual(expect.arrayContaining([...NEW_COLUMNS]));
        expect(original()).toEqual(seeded);
        const added = withDb(
          (db) =>
            db
              .prepare(`SELECT ${NEW_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "product_edges"`)
              .all() as unknown[],
        );
        const empty = {
          detectedIntegrationKind: null,
          detectedStrength: null,
          detectedDirection: null,
        };
        expect(added).toEqual([empty, empty, empty]);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("reverse: drops the columns, forgets the migration, leaves every edge unchanged", () => {
      // A value kept while migrated is what the reverse loses — and only that.
      sqlite.exec(`UPDATE "product_edges" SET "detectedStrength" = 'contract' WHERE "id" = 'e-2'`);
      withDb((db) => db.exec(ROLLBACK_SQL));
      for (const c of NEW_COLUMNS) expect(columns()).not.toContain(c);
      expect(applied()).toBe(false);
      expect(original()).toEqual(seeded);
    });

    it(
      "up again: `migrate deploy` re-applies it and the edges still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        expect(columns()).toEqual(expect.arrayContaining([...NEW_COLUMNS]));
        expect(original()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twins are the same operations, idempotent", () => {
      for (const c of NEW_COLUMNS) {
        expect(PG_MIGRATION_SQL).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${c}" TEXT;`));
        expect(PG_ROLLBACK_SQL).toMatch(new RegExp(`DROP COLUMN IF EXISTS "${c}";`));
      }
      expect(PG_ROLLBACK_SQL).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
