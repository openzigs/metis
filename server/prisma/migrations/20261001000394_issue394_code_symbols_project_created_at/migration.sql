-- Issue #394 — index for the code-graph symbol-cache fingerprint.
--
-- `prismaSymbolIndex.getSymbols` (server/src/lib/code-graph/project-code-searcher.ts)
-- runs `count(*)` + `max("createdAt")` over one project's symbols on EVERY search
-- to decide whether its cached symbol set is still current. This index turns
-- max("createdAt") into an index seek; count(*) still walks the project's index
-- entries (the existing (projectId, kind) index could already serve that). It
-- adds a little write cost to every symbol insert during ingest (PR #413 review).
--
-- Rollback: DROP INDEX "code_symbols_projectId_createdAt_idx";

-- CreateIndex
CREATE INDEX "code_symbols_projectId_createdAt_idx" ON "code_symbols"("projectId", "createdAt");
