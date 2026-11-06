-- Issue #1831 (epic #1827) — the identity of the symbol a requirement→code
-- citation names (Postgres twin of
-- server/prisma/migrations/20261114001831_issue1831_citation_symbol_identity;
-- see that file for the rationale). Three nullable TEXT columns, nothing
-- backfilled. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261114001831_issue1831_citation_symbol_identity.sql

ALTER TABLE "requirement_code_mappings" ADD COLUMN IF NOT EXISTS "symbolContentHash" TEXT,
ADD COLUMN IF NOT EXISTS "symbolKind" TEXT,
ADD COLUMN IF NOT EXISTS "symbolQualifiedName" TEXT;
