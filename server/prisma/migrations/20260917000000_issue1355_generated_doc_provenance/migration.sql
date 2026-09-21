-- Issue #1355 — immutable generated-document version provenance and shared
-- revision identity for publication/reconciliation/regeneration siblings.

ALTER TABLE "generated_document_versions"
  ADD COLUMN "revisionId" TEXT;

ALTER TABLE "generated_document_versions"
  ADD COLUMN "provenanceManifest" TEXT;

CREATE INDEX "generated_document_versions_revisionId_idx"
  ON "generated_document_versions"("revisionId");