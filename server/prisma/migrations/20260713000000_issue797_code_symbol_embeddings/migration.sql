-- Epic #780 / Issue #797 — durable metadata for code-symbol embeddings.
--
-- `search_code_symbols` was BM25-only in production: `project-code-searcher.ts`
-- passed a NO-OP vector store, so the vector half of `HybridCodeSearch` never
-- ran and #780's embedder upgrade never reached code retrieval. This table is
-- the persistence that was missing.
--
-- The VECTOR is deliberately NOT a column here. It lives in the existing vector
-- store (pgvector `rag_vectors` in prod, Lance by default, local JSON in tests)
-- under the synthetic namespace `<projectId>__symbols`, for the same reason
-- document chunks do: a `vector(N)` column's width is derived at runtime from
-- the active embedder and a static Prisma migration cannot express it (see the
-- comment block at the top of `server/src/lib/rag/vector-store-pgvector.ts`),
-- and SQLite has no vector type at all.
--
-- What this row holds is the index-time TEXT (`formatSymbolForEmbedding` output)
-- plus its content hash and the model tag. The text is the source of truth an
-- #787 re-index reads, which is what lets a model flip re-embed every symbol
-- with NO repo checkout — `code_symbols` stores no signature, docstring or body.
--
-- ADDITIVE — a new, empty table. No backfill: existing deployments get an empty
-- `code_symbol_embeddings` and the next code-graph ingest populates it.
-- `embeddingModel = ''` means PENDING (row written by ingest, vector not yet
-- computed by the background embed job).
--
-- CASCADE on symbolId is load-bearing: ingest delete-then-recreates a re-parsed
-- file's `code_symbols` rows, so the stale embedding rows are pruned for free.

-- CreateTable
CREATE TABLE "code_symbol_embeddings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "codeGraphId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "code_symbol_embeddings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "code_symbol_embeddings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "code_symbol_embeddings_symbolId_key" ON "code_symbol_embeddings"("symbolId");

-- CreateIndex
CREATE INDEX "code_symbol_embeddings_projectId_embeddingModel_idx" ON "code_symbol_embeddings"("projectId", "embeddingModel");

-- CreateIndex
CREATE INDEX "code_symbol_embeddings_codeGraphId_idx" ON "code_symbol_embeddings"("codeGraphId");
