-- Epic #895: persist structured schema graph (JSON text) for the interactive
-- Schema Graph Explorer. Nullable; only populated for database-scope docs.
ALTER TABLE "generated_documents" ADD COLUMN "schemaGraph" TEXT;
