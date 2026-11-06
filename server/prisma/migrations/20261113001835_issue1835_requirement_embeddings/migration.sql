-- Issue #1835 (epic #1828) — requirements in the vector store.
--
--   requirement_embeddings  one row per embedded requirement: the hash of the
--                   text it was embedded from (title, body, acceptance
--                   criteria, tagged with the model) and the model whose
--                   vector is live in `<projectId>__requirements`. The
--                   reconcile (`syncRequirementEmbeddings`) compares it to the
--                   current requirements, so an edit or an embedder change
--                   re-embeds and nothing else does.
--
-- The VECTOR is not stored here: its width comes from the configured embedder
-- at runtime, which a static migration cannot express (`vector-store-pgvector.ts`).
--
-- `requirementId` cascades: an analysis re-run deletes and recreates its
-- requirements, and the row goes with the requirement it describes. A new,
-- empty table; nothing is backfilled (the first similarity query fills it).
--
-- Rollback: server/prisma/rollbacks/20261113001835_issue1835_requirement_embeddings.sql
-- (exercised by server/tests/requirement-embedding-migration-1835.sqlite.test.ts).

-- CreateTable
CREATE TABLE "requirement_embeddings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requirementId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "requirement_embeddings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "requirement_embeddings_requirementId_key" ON "requirement_embeddings"("requirementId");

-- CreateIndex
CREATE INDEX "requirement_embeddings_projectId_idx" ON "requirement_embeddings"("projectId");
