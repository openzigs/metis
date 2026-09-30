/**
 * Issue #402 — the #369 dedup cleanup and the #402 repoint, run against duplicate
 * rows on a REAL Postgres.
 *
 * `postgres-migrate-deploy` replays the Postgres chain from an EMPTY database, so
 * the dedupe `UPDATE` in #369's Postgres migration had never met a duplicate, and
 * the SQLite suites that do seed duplicates are skipped on Postgres. This suite
 * executes both Postgres `migration.sql` files verbatim, from disk, over the rows
 * in `helpers/draft-dedup-fixture.ts` (the same rows the SQLite twin,
 * `issue-draft-dedup-repoint-402.sqlite.test.ts`, asserts on).
 *
 * The rows cannot go into the real tables: the job's `prisma db push` already
 * built the partial unique index that forbids them. So the suite makes a scratch
 * schema holding `issue_drafts` and `publish_batches` copied column-for-column
 * from the pushed tables (`LIKE ... INCLUDING DEFAULTS`: columns, types and
 * defaults, but no indexes or foreign keys), puts it first on the `search_path`
 * of one dedicated connection, and runs the unqualified migration SQL there.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BATCHES,
  DRAFT_IDS_AFTER_402,
  DRAFTS,
  LIVE_AFTER_369,
  MIGRATION_369,
  MIGRATION_402,
  PARENTS_AFTER_402,
  USER_ID,
} from "./helpers/draft-dedup-fixture.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prisma",
  "postgres",
  "migrations",
);
const migrationSql = (name: string) =>
  readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8");

describe.runIf(enabled)(
  "issue_drafts dedup migrations on real Postgres (integration, #402)",
  () => {
    const client = new pg.Client({ connectionString: databaseUrl });
    // A fixed prefix plus random hex: safe to interpolate as an identifier.
    const schema = `t402_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

    const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
      client.query<T>(sql, params);

    beforeAll(async () => {
      await client.connect();
      await q(`CREATE SCHEMA "${schema}"`);
      await q(
        `CREATE TABLE "${schema}"."issue_drafts" (LIKE public."issue_drafts" INCLUDING DEFAULTS)`,
      );
      await q(
        `CREATE TABLE "${schema}"."publish_batches" (LIKE public."publish_batches" INCLUDING DEFAULTS)`,
      );
      await q(`SET search_path TO "${schema}"`);
      for (const r of DRAFTS) {
        await q(
          `INSERT INTO "issue_drafts"
           ("id", "projectId", "parentDraftId", "title", "body", "status", "dedupHash",
            "createdAt", "updatedAt", "deletedAt")
         VALUES ($1, $2, $3, 'T', 'B', $4, $5, $6, $6, $7)`,
          [r.id, r.projectId, r.parentDraftId, r.status, r.dedupHash, r.createdAt, r.deletedAt],
        );
      }
      for (const b of BATCHES) {
        await q(
          `INSERT INTO "publish_batches"
           ("id", "projectId", "status", "targetOwner", "targetRepo", "archived",
            "startedById", "metadata", "updatedAt")
         VALUES ($1, $2, $3, 'acme', 'metis', $4, $5, $6, CURRENT_TIMESTAMP)`,
          [b.id, b.projectId, b.status, b.archived, USER_ID, b.metadata],
        );
      }
      await q(migrationSql(MIGRATION_369));
      await q(migrationSql(MIGRATION_402));
    });

    afterAll(async () => {
      await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
      await client.end();
    });

    const liveIds = async () =>
      (await q<{ id: string }>(`SELECT "id" FROM "issue_drafts" WHERE "deletedAt" IS NULL`)).rows
        .map((r) => r.id)
        .sort();

    it("retires live duplicates, keeping the published or else the oldest", async () => {
      expect(await liveIds()).toEqual(LIVE_AFTER_369);
      // A row already soft-deleted keeps its original timestamp.
      const gone = await q<{ deletedAt: string }>(
        `SELECT "deletedAt"::text AS "deletedAt" FROM "issue_drafts" WHERE "id" = 'd_gone'`,
      );
      expect(gone.rows[0].deletedAt).toBe("2026-09-01 00:00:00");
    });

    it("then builds the partial unique index in the scratch schema", async () => {
      const idx = await q<{ indexdef: string }>(
        `SELECT "indexdef" FROM pg_indexes
       WHERE schemaname = $1 AND indexname = 'issue_drafts_projectId_dedupHash_key'`,
        [schema],
      );
      expect(idx.rows).toHaveLength(1);
      expect(idx.rows[0].indexdef).toMatch(/UNIQUE INDEX .*WHERE \("deletedAt" IS NULL\)/);
      await expect(
        q(
          `INSERT INTO "issue_drafts" ("id", "projectId", "title", "body", "dedupHash", "updatedAt")
         VALUES ('dup', 'p1', 'T', 'B', 'h1', CURRENT_TIMESTAMP)`,
        ),
      ).rejects.toMatchObject({ code: "23505" });
    });

    it("repoints a retired epic's live children at the survivor", async () => {
      const rows = await q<{ id: string; parentDraftId: string }>(
        `SELECT "id", "parentDraftId" FROM "issue_drafts" WHERE "parentDraftId" IS NOT NULL`,
      );
      expect(Object.fromEntries(rows.rows.map((r) => [r.id, r.parentDraftId]))).toEqual(
        PARENTS_AFTER_402,
      );
    });

    it("repoints an unfinished batch's draftIds, leaving settled and foreign batches alone", async () => {
      const rows = await q<{ id: string; metadata: string | null }>(
        `SELECT "id", "metadata" FROM "publish_batches"`,
      );
      for (const seeded of BATCHES) {
        const after = rows.rows.find((r) => r.id === seeded.id)?.metadata ?? null;
        const expected = DRAFT_IDS_AFTER_402[seeded.id];
        if (!expected) {
          expect(after, seeded.id).toBe(seeded.metadata);
          continue;
        }
        const parsed = JSON.parse(after ?? "{}");
        expect(parsed.draftIds, seeded.id).toEqual(expected);
        expect(parsed.secretRef).toBe("${vault:gh}");
        expect(parsed.additionalLabels).toEqual(["x"]);
        // Every draft id that names a draft now names a live one in the batch's
        // project — createBatch's DRAFT_MISMATCH count check.
        const known = expected.filter((id) => id !== "nope");
        const found = await q(
          `SELECT 1 FROM "issue_drafts"
         WHERE "id" = ANY($1) AND "projectId" = 'p1' AND "deletedAt" IS NULL`,
          [known],
        );
        expect(found.rowCount, seeded.id).toBe(known.length);
      }
    });

    it("is a no-op when both migrations run again", async () => {
      const snapshot = async () => ({
        drafts: (
          await q(`SELECT "id", "parentDraftId", "deletedAt" FROM "issue_drafts" ORDER BY "id"`)
        ).rows,
        batches: (await q(`SELECT "id", "metadata" FROM "publish_batches" ORDER BY "id"`)).rows,
      });
      const before = await snapshot();
      await q(migrationSql(MIGRATION_369));
      await q(migrationSql(MIGRATION_402));
      expect(await snapshot()).toEqual(before);
    });
  },
);
