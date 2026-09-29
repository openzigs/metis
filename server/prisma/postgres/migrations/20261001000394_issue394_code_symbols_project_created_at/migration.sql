-- Issue #394 — index for the code-graph symbol-cache fingerprint (Postgres mirror).
-- See the SQLite migration of the same name for the rationale.
-- `IF NOT EXISTS` keeps the full chain idempotent (issue #556).
--
-- Rollback: DROP INDEX IF EXISTS "code_symbols_projectId_createdAt_idx";

-- CreateIndex
CREATE INDEX IF NOT EXISTS "code_symbols_projectId_createdAt_idx" ON "code_symbols"("projectId", "createdAt");
