/**
 * Issue #1618 — the typed-edge / shared-resource migration and its committed
 * reverse script, applied up -> reverse -> up to a SQLite database seeded with
 * edges written BEFORE the migration. Prisma Migrate has no down migrations, so
 * the reverse is a hand-run SQL file (server/prisma/rollbacks/); this proves it
 * works, leaves every pre-existing edge as it was at each step, and lets
 * `prisma migrate deploy` apply the migration again afterwards.
 *
 * The migration rebuilds `product_edges` (SQLite cannot drop NOT NULL in
 * place), so "unchanged" is checked column by column over every seeded row.
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

const MIGRATION = "20261106001618_issue1618_product_edge_coupling";
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);
const PG_ROLLBACK_SQL = readFileSync(
  path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
  "utf-8",
);

/** The columns every edge had before the migration. */
const ORIGINAL_COLUMNS = [
  "id",
  "productId",
  "sourceRepoId",
  "targetRepoId",
  "edgeType",
  "confidence",
  "evidence",
  "sourceFile",
  "targetFile",
  "commitSha",
  "createdAt",
  "updatedAt",
] as const;

const NEW_COLUMNS = [
  "integrationKind",
  "strength",
  "direction",
  "origin",
  "resourceId",
  "contractDocId",
  "declaredById",
] as const;

const SEEDED_IDS = ["e-1", "e-2", "e-3"];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1618 — product edge coupling migration: up -> reverse -> up",
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
    const notNull = (table: string, column: string): boolean =>
      withDb(
        (db) =>
          (
            db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{
              name: string;
              notnull: number;
            }>
          ).find((c) => c.name === column)?.notnull === 1,
      );
    const tableExists = (table: string): boolean =>
      withDb(
        (db) =>
          (
            db
              .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?`)
              .get(table) as { n: number }
          ).n === 1,
      );
    const original = (): Array<Record<string, unknown>> =>
      withDb(
        (db) =>
          db
            .prepare(
              `SELECT ${ORIGINAL_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "product_edges"
               WHERE "id" IN (${SEEDED_IDS.map(() => "?").join(",")}) ORDER BY "id"`,
            )
            .all(...SEEDED_IDS) as Array<Record<string, unknown>>,
      );
    const edgeIds = (): string[] =>
      withDb((db) =>
        (
          db.prepare(`SELECT "id" FROM "product_edges" ORDER BY "id"`).all() as Array<{
            id: string;
          }>
        ).map((r) => r.id),
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
    const indexes = (): string[] =>
      withDb((db) =>
        (db.prepare(`PRAGMA index_list("product_edges")`).all() as Array<{ name: string }>).map(
          (i) => i.name,
        ),
      );

    let seeded: Array<Record<string, unknown>> = [];

    beforeAll(() => {
      sqlite = createMigratedSqlite("1618-edge-migration", { stopBefore: MIGRATION });
      const now = new Date("2026-10-01T00:00:00Z").toISOString();
      sqlite.exec(
        `INSERT INTO "users" ("id","username","displayName","email","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["u-1", "u-1", "U", "u1@example.test", now, now],
      );
      sqlite.exec(
        `INSERT INTO "projects" ("id","name","slug","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["p-1", "P", "p-1", "u-1", now, now],
      );
      for (const id of ["rc-1", "rc-2", "rc-3"]) {
        sqlite.exec(
          `INSERT INTO "repo_connections" ("id","projectId","label","createdAt","updatedAt") VALUES (?,?,?,?,?)`,
          [id, "p-1", id, now, now],
        );
      }
      sqlite.exec(
        `INSERT INTO "products" ("id","name","slug","createdById","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["prod-1", "Product", "prod-1", "u-1", now, now],
      );
      const rows: Array<[string, string, string, string, number, string, string | null]> = [
        ["e-1", "rc-1", "rc-2", "calls", 0.95, '[{"filePath":"a.yaml"}]', "a.yaml"],
        ["e-2", "rc-2", "rc-3", "imports", 0.8, "[]", null],
        ["e-3", "rc-3", "rc-1", "produces", 0.9, '[{"pattern":"protobuf_package"}]', "x.proto"],
      ];
      for (const [id, source, target, type, confidence, evidence, file] of rows) {
        sqlite.exec(
          `INSERT INTO "product_edges" ("id","productId","sourceRepoId","targetRepoId","edgeType","confidence","evidence","sourceFile","targetFile","commitSha","createdAt","updatedAt")
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            id,
            "prod-1",
            source,
            target,
            type,
            confidence,
            evidence,
            file,
            file,
            "abc123",
            now,
            now,
          ],
        );
      }
      seeded = original();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it("starts in the old shape, with three pre-existing edges", () => {
      expect(columns("product_edges")).not.toContain("origin");
      expect(tableExists("product_resources")).toBe(false);
      expect(notNull("product_edges", "targetRepoId")).toBe(true);
      expect(seeded).toHaveLength(3);
    });

    it(
      "up: adds the coupling columns and resources, leaves every edge unchanged as detected",
      () => {
        sqlite.apply(MIGRATION);
        expect(applied()).toBe(true);
        expect(columns("product_edges")).toEqual(expect.arrayContaining([...NEW_COLUMNS]));
        expect(tableExists("product_resources")).toBe(true);
        expect(notNull("product_edges", "targetRepoId")).toBe(false);
        expect(indexes()).toEqual(
          expect.arrayContaining([
            "product_edges_productId_idx",
            "product_edges_sourceRepoId_idx",
            "product_edges_targetRepoId_idx",
            "product_edges_productId_edgeType_idx",
            "product_edges_resourceId_idx",
            "product_edges_contractDocId_idx",
          ]),
        );
        expect(original()).toEqual(seeded);
        const added = withDb(
          (db) =>
            db
              .prepare(
                `SELECT ${NEW_COLUMNS.map((c) => `"${c}"`).join(", ")} FROM "product_edges" ORDER BY "id"`,
              )
              .all() as unknown[],
        );
        const legacy = {
          integrationKind: null,
          strength: null,
          direction: null,
          origin: "detected",
          resourceId: null,
          contractDocId: null,
          declaredById: null,
        };
        expect(added).toEqual([legacy, legacy, legacy]);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("reverse: restores the old shape, drops resources, forgets the migration, keeps every pre-existing edge", () => {
      // What the reverse loses — and only that: a resource, an edge through it
      // with no target repo, and the coupling values on an edge that has one.
      const now = new Date().toISOString();
      sqlite.exec(
        `INSERT INTO "product_resources" ("id","productId","kind","name","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`,
        ["res-1", "prod-1", "table", "orders", now, now],
      );
      sqlite.exec(
        `INSERT INTO "product_edges" ("id","productId","sourceRepoId","targetRepoId","resourceId","edgeType","confidence","origin","integrationKind","strength","direction","createdAt","updatedAt")
         VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?,?)`,
        [
          "e-through",
          "prod-1",
          "rc-1",
          "res-1",
          "produces",
          1,
          "declared",
          "database",
          "intrusive",
          "writes",
          now,
          now,
        ],
      );
      sqlite.exec(
        `UPDATE "product_edges" SET "strength" = 'contract', "integrationKind" = 'api', "resourceId" = 'res-1' WHERE "id" = 'e-1'`,
      );

      withDb((db) => db.exec(ROLLBACK_SQL));

      expect(applied()).toBe(false);
      for (const c of NEW_COLUMNS) expect(columns("product_edges")).not.toContain(c);
      expect(tableExists("product_resources")).toBe(false);
      expect(notNull("product_edges", "targetRepoId")).toBe(true);
      expect(indexes()).not.toContain("product_edges_resourceId_idx");
      expect(edgeIds()).toEqual(SEEDED_IDS);
      expect(original()).toEqual(seeded);
      // Foreign keys still hold after the rebuild.
      expect(withDb((db) => db.prepare(`PRAGMA foreign_key_check`).all())).toEqual([]);
    });

    it(
      "up again: `migrate deploy` re-applies it and the edges still read back unchanged",
      () => {
        sqlite.applyRemaining();
        expect(applied()).toBe(true);
        expect(columns("product_edges")).toEqual(expect.arrayContaining([...NEW_COLUMNS]));
        expect(tableExists("product_resources")).toBe(true);
        expect(original()).toEqual(seeded);
        const origins = withDb(
          (db) =>
            db
              .prepare(`SELECT DISTINCT "origin", "strength" FROM "product_edges"`)
              .all() as unknown[],
        );
        expect(origins).toEqual([{ origin: "detected", strength: null }]);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres reverse script is the same operation, idempotent", () => {
      for (const stmt of [
        /DELETE FROM "product_edges" WHERE "targetRepoId" IS NULL/,
        /ALTER COLUMN "targetRepoId" SET NOT NULL/,
        ...NEW_COLUMNS.map((c) => new RegExp(`DROP COLUMN IF EXISTS "${c}"`)),
        /DROP TABLE IF EXISTS "product_resources"/,
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      ]) {
        expect(PG_ROLLBACK_SQL).toMatch(stmt);
      }
      // The NULL-target rows go BEFORE the NOT NULL is restored, or it fails.
      expect(PG_ROLLBACK_SQL.indexOf("IS NULL")).toBeLessThan(
        PG_ROLLBACK_SQL.indexOf("SET NOT NULL"),
      );
    });
  },
);
