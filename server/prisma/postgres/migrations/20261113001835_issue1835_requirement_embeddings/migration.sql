-- Issue #1835 (epic #1828) — requirements in the vector store. Postgres twin
-- of server/prisma/migrations/20261113001835_issue1835_requirement_embeddings;
-- see that file for the rationale. One new table, no vector column (the vector
-- lives in `rag_vectors` under `<projectId>__requirements`), `requirementId`
-- cascading with its requirement.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261113001835_issue1835_requirement_embeddings.sql

-- CreateTable
CREATE TABLE IF NOT EXISTS "requirement_embeddings" (
    "id" TEXT NOT NULL,
    "requirementId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "embeddedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requirement_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "requirement_embeddings_requirementId_key" ON "requirement_embeddings"("requirementId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirement_embeddings_projectId_idx" ON "requirement_embeddings"("projectId");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'requirement_embeddings_requirementId_fkey') THEN
    EXECUTE 'ALTER TABLE "requirement_embeddings" ADD CONSTRAINT "requirement_embeddings_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "requirements"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
