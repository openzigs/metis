-- Issue #1355 — immutable generated-document version provenance and shared
-- revision identity for publication/reconciliation/regeneration siblings.

ALTER TABLE "generated_document_versions"
  ADD COLUMN IF NOT EXISTS "revisionId" TEXT,
  ADD COLUMN IF NOT EXISTS "provenanceManifest" TEXT;

CREATE INDEX IF NOT EXISTS "generated_document_versions_revisionId_idx"
  ON "generated_document_versions"("revisionId");