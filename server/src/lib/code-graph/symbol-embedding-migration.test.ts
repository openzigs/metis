/**
 * Epic #780 / Issue #797 — `code_symbol_embeddings` migration sanity.
 *
 * Asserts the table is created in BOTH the SQLite and Postgres incremental
 * migrations, that the Postgres DDL is idempotent (issue #556: the history must
 * replay cleanly over the cumulative init baseline on a fresh database), that the
 * baseline itself carries the table (parity guard), that both Prisma schemas
 * declare the model — and that the CASCADE on `symbolId` is present, because
 * ingest's delete-then-recreate of a re-parsed file's symbols is what prunes stale
 * rows.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dirname ?? __dirname, "..", "..", "..", "..");
const MIG = "20260713000000_issue797_code_symbol_embeddings";

const sqliteMigration = readFileSync(
  join(repoRoot, "server/prisma/migrations", MIG, "migration.sql"),
  "utf-8",
);
const postgresMigration = readFileSync(
  join(repoRoot, "server/prisma/postgres/migrations", MIG, "migration.sql"),
  "utf-8",
);
const sqliteSchema = readFileSync(join(repoRoot, "server/prisma/schema.prisma"), "utf-8");
const postgresSchema = readFileSync(
  join(repoRoot, "server/prisma/postgres/schema.prisma"),
  "utf-8",
);
const postgresInit = readFileSync(
  join(repoRoot, "server/prisma/postgres/migrations/00000000000000_init/migration.sql"),
  "utf-8",
);

describe("code_symbol_embeddings migration (#797)", () => {
  it("SQLite migration creates the table", () => {
    expect(sqliteMigration).toContain('CREATE TABLE "code_symbol_embeddings"');
  });

  it("Postgres migration creates the table idempotently (issue #556)", () => {
    expect(postgresMigration).toContain('CREATE TABLE IF NOT EXISTS "code_symbol_embeddings"');
    expect(postgresMigration).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/);
  });

  it("the cumulative Postgres init baseline carries the table (parity guard)", () => {
    expect(postgresInit).toContain('CREATE TABLE "code_symbol_embeddings"');
  });

  it("is 1:1 with a symbol", () => {
    expect(sqliteMigration).toContain(
      'CREATE UNIQUE INDEX "code_symbol_embeddings_symbolId_key" ON "code_symbol_embeddings"("symbolId")',
    );
    expect(postgresMigration).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "code_symbol_embeddings_symbolId_key"',
    );
  });

  it("cascade-deletes with its symbol — this is what prunes stale rows on re-ingest", () => {
    expect(sqliteMigration).toMatch(
      /code_symbol_embeddings_symbolId_fkey.*REFERENCES "code_symbols".*ON DELETE CASCADE/s,
    );
    expect(postgresMigration).toMatch(
      /code_symbol_embeddings_symbolId_fkey.*REFERENCES "code_symbols".*ON DELETE CASCADE/s,
    );
  });

  it("indexes (projectId, embeddingModel) — the coverage + migration-status query", () => {
    for (const sql of [sqliteMigration, postgresMigration]) {
      expect(sql).toContain('"code_symbol_embeddings_projectId_embeddingModel_idx"');
    }
  });

  it("defaults embeddingModel to '' (PENDING), so ingest never claims an embedding", () => {
    for (const sql of [sqliteMigration, postgresMigration]) {
      expect(sql).toMatch(/"embeddingModel" TEXT NOT NULL DEFAULT ''/);
    }
  });

  it("stores NO vector column — vectors live in the vector store, not Prisma", () => {
    // The invariant `vector-store-pgvector.ts` documents: a `vector(N)` width is
    // runtime-derived from the active embedder and a static migration cannot
    // express it (and SQLite has no vector type at all). Comments are stripped
    // first — the migration headers EXPLAIN this rule, so they mention it.
    const ddl = (sql: string): string =>
      sql
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("--"))
        .join("\n");
    for (const sql of [sqliteMigration, postgresMigration]) {
      expect(ddl(sql)).not.toMatch(/\bvector\s*\(/i);
      expect(ddl(sql)).not.toMatch(/"embedding"\s+\w/);
    }
  });

  it("both Prisma schemas declare the model with @@map", () => {
    for (const s of [sqliteSchema, postgresSchema]) {
      expect(s).toMatch(/model CodeSymbolEmbedding \{/);
      expect(s).toMatch(/@@map\("code_symbol_embeddings"\)/);
      const model = s.slice(s.indexOf("model CodeSymbolEmbedding {"));
      const body = model.slice(0, model.indexOf("\n}"));
      expect(body).toMatch(/symbolId\s+String\s+@unique/);
      expect(body).toMatch(/text\s+String/);
      expect(body).toMatch(/embeddingModel\s+String\s+@default\(""\)/);
    }
  });
});
