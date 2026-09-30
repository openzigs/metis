/**
 * Issue #525 — the generated-document reclassification on a REAL Postgres.
 *
 * `postgres-migrate-deploy` replays the chain from an EMPTY database, so the
 * `UPDATE`s never meet a row there, and the SQLite twin
 * (`document-source-525.sqlite.test.ts`) is skipped on Postgres. This suite runs
 * the Postgres `migration.sql` verbatim, from disk, over seeded rows in a
 * scratch schema cloned from the pushed `documents` table.
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

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const MIGRATION = "20261006000525_issue525_generated_source_by_id";
const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "prisma",
    "postgres",
    "migrations",
    MIGRATION,
    "migration.sql",
  ),
  "utf8",
);

describe.runIf(enabled)("generated documents classified by id (real Postgres, #525)", () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  // A fixed prefix plus random hex: safe to interpolate as an identifier.
  const schema = `t525_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    client.query<T>(sql, params);

  beforeAll(async () => {
    await client.connect();
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`CREATE TABLE "${schema}"."documents" (LIKE public."documents" INCLUDING DEFAULTS)`);
    await q(`SET search_path TO "${schema}"`);
    // [id, filename, source as #474's filename backfill left it]
    const rows: Array<[string, string, string]> = [
      ["gendoc-g1", "generated-doc-g1.md", "generated"],
      ["gendoc-g2:rev-2", "generated-doc-g2.md", "generated"],
      ["cupload1", "generated-doc-notes.md", "generated"],
      ["gendoc-g3", "renamed.md", "upload"],
      ["gendocx", "x.md", "upload"],
      ["GENDOC-y", "y.md", "upload"],
      ["crepo", "connector:repo:c1:README.md", "repo"],
      ["cjira", "jira:ABC-1", "jira"],
    ];
    for (const [id, filename, source] of rows) {
      await q(
        `INSERT INTO "documents" ("id", "projectId", "filename", "source", "mimeType",
           "sizeBytes", "storagePath", "checksum", "uploadedById")
         VALUES ($1, 'p1', $2, $3, 'text/markdown', 1, 'p', 'c', 'u1')`,
        [id, filename, source],
      );
    }
    await q(migrationSql);
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    await client.end();
  });

  const sources = async () =>
    Object.fromEntries(
      (
        await q<{ id: string; source: string }>(
          `SELECT "id", "source" FROM "documents" ORDER BY "id"`,
        )
      ).rows.map((r) => [r.id, r.source]),
    );

  it("a row is generated exactly when its id starts with gendoc-", async () => {
    expect(await sources()).toEqual({
      "gendoc-g1": "generated",
      "gendoc-g2:rev-2": "generated",
      cupload1: "upload",
      "gendoc-g3": "generated",
      gendocx: "upload",
      "GENDOC-y": "upload",
      crepo: "repo",
      cjira: "jira",
    });
  });

  it("is a no-op when run again", async () => {
    const before = await sources();
    await q(migrationSql);
    expect(await sources()).toEqual(before);
  });
});
