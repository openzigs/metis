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
ALTER TABLE "code_graphs" ADD COLUMN "extractorVersion" INTEGER;

-- The files an upgrade could not reach, by path, with the hash of the content
-- that failed (JSON; NULL: none). A listed file is retried only when its
-- content changes, so one unparseable file does not make every ingest repeat
-- the whole upgrade. Rollback: DROP COLUMN "extractorUpgradeFailed" — the next
-- ingest then simply does not know which files still have the older shape.
ALTER TABLE "code_graphs" ADD COLUMN "extractorUpgradeFailed" TEXT;

-- When an ingest last rewrote this graph's rows in place for an extractor
-- upgrade. Automatic document regeneration reads it as the evidence that a
-- difference confined to graph rows IS that rewrite. NULL — every existing
-- row — means no upgrade has rewritten the graph. Rollback: DROP COLUMN
-- "extractorUpgradedAt"; an upgrade refresh then regenerates documents.
ALTER TABLE "code_graphs" ADD COLUMN "extractorUpgradedAt" DATETIME;

-- The inputs a generated document's latest version was acknowledged to stand
-- for without being regenerated: at most one row per document, written when a
-- check finds that an extractor upgrade rewrote the graph and nothing else the
-- document reads changed. A table of its own, not a column on
-- "generated_document_versions": every reader of a version row would otherwise
-- carry it, and a version's provenance stays as published. New, empty table:
-- no backfill. "graphs" is JSON: per graph the document reads (keyed by a hash
-- of the graph id), a digest of that graph's rows in the acknowledged inputs
-- and the "extractorUpgradedAt" mark the graph carried — what lets the next
-- difference be put down to an upgrade of THAT graph or not. Rollback: DROP
-- TABLE "generated_document_acknowledgements"; the next check then compares
-- against each version's own manifest again.
CREATE TABLE "generated_document_acknowledgements" (
    "documentId" TEXT NOT NULL PRIMARY KEY,
    "version" INTEGER NOT NULL,
    "upgradedAt" DATETIME NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "graphs" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "generated_document_acknowledgements_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "generated_documents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
