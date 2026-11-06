-- Issue #1831 (epic #1827) — the identity of the symbol a requirement→code
-- citation names, kept on the row so re-validation can find it in a new code
-- graph after an ingest has deleted the old symbol row (`codeSymbolId` is
-- ON DELETE SET NULL, so the link alone forgets which symbol it was).
--
--   symbolQualifiedName  the cited symbol's qualified name when last validated
--   symbolKind           its kind (function | class | method | ...)
--   symbolContentHash    its content hash (SHA-256 of its source slice)
--
-- Nullable TEXT, nothing backfilled: a file-level link and a link written
-- before #1831 read null, and re-validation falls back to the live symbol row
-- while the link still has one.
--
-- Rollback: server/prisma/rollbacks/20261114001831_issue1831_citation_symbol_identity.sql
-- (exercised by server/tests/citation-revalidation-1831.sqlite.test.ts).

-- AlterTable
ALTER TABLE "requirement_code_mappings" ADD COLUMN "symbolContentHash" TEXT;
ALTER TABLE "requirement_code_mappings" ADD COLUMN "symbolKind" TEXT;
ALTER TABLE "requirement_code_mappings" ADD COLUMN "symbolQualifiedName" TEXT;
