-- Issue #2280 (epic #2227) — saved document readings. Postgres twin of
-- server/prisma/migrations/20261123002280_issue2280_saved_document_readings;
-- see that file for the rationale. One new table, one row per saved reading,
-- cascading with its document.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback: server/prisma/postgres/rollbacks/20261123002280_issue2280_saved_document_readings.sql

-- CreateTable
CREATE TABLE IF NOT EXISTS "saved_document_readings" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "readerVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "reading" TEXT NOT NULL,
    "usage" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_document_readings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "saved_document_readings_projectId_documentId_idx" ON "saved_document_readings"("projectId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "saved_document_readings_key" ON "saved_document_readings"("documentId", "checksum", "readerVersion", "model", "textHash");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'saved_document_readings_documentId_fkey') THEN
    EXECUTE 'ALTER TABLE "saved_document_readings" ADD CONSTRAINT "saved_document_readings_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
