/**
 * Issue #474 — the `documents.source` backfill on a REAL Postgres.
 *
 * `postgres-migrate-deploy` replays the Postgres chain from an EMPTY database,
 * so the backfill `UPDATE`s never meet a row there, and the SQLite twin
 * (`document-source-474.sqlite.test.ts`) is skipped on Postgres. This suite
 * runs the Postgres `migration.sql` verbatim, from disk, over seeded rows in a
 * scratch schema cloned from the pushed `documents` table with the two new
 * columns dropped — the shape a deployed database meets the migration in.
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

const MIGRATION = "20261004000474_issue474_document_source_title";
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

describe.runIf(enabled)("documents.source backfill (real Postgres, #474)", () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  // A fixed prefix plus random hex: safe to interpolate as an identifier.
  const schema = `t474_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    client.query<T>(sql, params);

  beforeAll(async () => {
    await client.connect();
    await q(`CREATE SCHEMA "${schema}"`);
    await q(`CREATE TABLE "${schema}"."documents" (LIKE public."documents" INCLUDING DEFAULTS)`);
    await q(`ALTER TABLE "${schema}"."documents" DROP COLUMN "source", DROP COLUMN "title"`);
    await q(`SET search_path TO "${schema}"`);
    const rows: Array<[string, string, string]> = [
      ["d-repo", "connector:repo:c1:README.md", "text/markdown"],
      ["d-db", "connector:db:c2:public.users.md", "text/markdown"],
      ["d-conf", "confluence:DOCS:123", "text/markdown"],
      ["d-jira", "jira:ABC-1", "text/markdown"],
      ["d-gen", "generated-doc-abc.md", "text/markdown"],
      ["d-upload-jira-pdf", "jira:ABC-2.pdf", "application/pdf"],
      ["d-upload-case", "JIRA:ABC-3", "text/markdown"],
      ["d-upload", "Spec v2.docx", "application/octet-stream"],
    ];
    for (const [id, filename, mimeType] of rows) {
      await q(
        `INSERT INTO "documents" ("id", "projectId", "filename", "mimeType", "sizeBytes",
           "storagePath", "checksum", "uploadedById")
         VALUES ($1, 'p1', $2, $3, 1, 'p', 'c', 'u1')`,
        [id, filename, mimeType],
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
        await q<{ id: string; source: string; title: string | null }>(
          `SELECT "id", "source", "title" FROM "documents" ORDER BY "id"`,
        )
      ).rows.map((r) => [r.id, [r.source, r.title]]),
    );

  it("classifies each connector's rows and leaves everything else an upload", async () => {
    expect(await sources()).toEqual({
      "d-repo": ["repo", null],
      "d-db": ["db", null],
      "d-conf": ["confluence", null],
      "d-jira": ["jira", null],
      "d-gen": ["generated", null],
      "d-upload-jira-pdf": ["upload", null],
      "d-upload-case": ["upload", null],
      "d-upload": ["upload", null],
    });
  });

  it("is a no-op when run again", async () => {
    const before = await sources();
    await q(migrationSql);
    expect(await sources()).toEqual(before);
  });
});
