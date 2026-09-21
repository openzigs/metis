-- Epic #780 / Issue #797 — durable metadata for code-symbol embeddings.
-- Postgres mirror of the SQLite migration of the same name; see it for the full
-- rationale (why the vector is NOT a column here, and why the `text` column is
-- what makes an #787 re-index possible without a repo checkout).
--
-- ADDITIVE — no existing table is altered. All DDL is idempotent (`IF NOT
-- EXISTS`; FKs wrapped in pg_constraint existence DO-blocks) so the full
-- migration history replays cleanly over the cumulative `00000000000000_init`
-- baseline on a fresh Postgres (issue #556 guard).

-- CreateTable
CREATE TABLE IF NOT EXISTS "code_symbol_embeddings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "codeGraphId" TEXT NOT NULL,
    "symbolId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_symbol_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "code_symbol_embeddings_symbolId_key" ON "code_symbol_embeddings"("symbolId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "code_symbol_embeddings_projectId_embeddingModel_idx" ON "code_symbol_embeddings"("projectId", "embeddingModel");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "code_symbol_embeddings_codeGraphId_idx" ON "code_symbol_embeddings"("codeGraphId");

-- AddForeignKey (guarded — bare ADD CONSTRAINT has no IF NOT EXISTS in Postgres)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_symbol_embeddings_symbolId_fkey') THEN
    ALTER TABLE "code_symbol_embeddings" ADD CONSTRAINT "code_symbol_embeddings_symbolId_fkey" FOREIGN KEY ("symbolId") REFERENCES "code_symbols" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'code_symbol_embeddings_projectId_fkey') THEN
    ALTER TABLE "code_symbol_embeddings" ADD CONSTRAINT "code_symbol_embeddings_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
