-- Issue #1071 — record which parser version wrote a code graph.
--
-- An incremental ingest skips a file whose content hash matches, so a parser
-- change (here: a Go method named after its receiver type, and Go calls bound
-- by declared types) never reached a stored graph. `extractorVersion` holds the
-- `CODE_GRAPH_EXTRACTOR_VERSION` (`server/src/lib/code-graph/ingest.ts`) the
-- graph's parser rows were last written with; the next incremental ingest of a
-- graph recorded with an older one upgrades the affected files in place.
--
-- NULL — every existing row — means "built before #1071" and reads as older
-- than any version. No backfill: that is exactly what the existing graphs are,
-- and their next ingest sets it. A nullable column with no default is a
-- metadata-only change.
--
-- Rollback (documentation):
--   ALTER TABLE "code_graphs" DROP COLUMN "extractorVersion";
-- After it no stored graph is upgraded on ingest; a full re-ingest still is.
ALTER TABLE "code_graphs" ADD COLUMN IF NOT EXISTS "extractorVersion" INTEGER;

-- The files an upgrade could not reach, by path, with the hash of the content
-- that failed (JSON; NULL: none). A listed file is retried only when its
-- content changes, so one unparseable file does not make every ingest repeat
-- the whole upgrade. Rollback: DROP COLUMN "extractorUpgradeFailed" — the next
-- ingest then simply does not know which files still have the older shape.
ALTER TABLE "code_graphs" ADD COLUMN IF NOT EXISTS "extractorUpgradeFailed" TEXT;

-- When an ingest last rewrote this graph's rows in place for an extractor
-- upgrade. Automatic document regeneration reads it as the evidence that a
-- difference confined to graph rows IS that rewrite. NULL — every existing
-- row — means no upgrade has rewritten the graph. Rollback: DROP COLUMN
-- "extractorUpgradedAt"; an upgrade refresh then regenerates documents.
ALTER TABLE "code_graphs" ADD COLUMN IF NOT EXISTS "extractorUpgradedAt" TIMESTAMP(3);

-- The inputs a generated document's latest version was acknowledged to stand
-- for without being regenerated (see the SQLite migration of the same name):
-- at most one row per document. Idempotent DDL, as every Postgres migration
-- here: `IF NOT EXISTS`, and the FK behind a pg_constraint existence guard.
-- Rollback: DROP TABLE "generated_document_acknowledgements";
CREATE TABLE IF NOT EXISTS "generated_document_acknowledgements" (
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "upgradedAt" TIMESTAMP(3) NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generated_document_acknowledgements_pkey" PRIMARY KEY ("documentId")
);

DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'generated_document_acknowledgements_documentId_fkey') THEN
    EXECUTE 'ALTER TABLE "generated_document_acknowledgements" ADD CONSTRAINT "generated_document_acknowledgements_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "generated_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;
