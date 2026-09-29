-- Issue #394 — index for the code-graph symbol-cache fingerprint.
--
-- `prismaSymbolIndex.getSymbols` (server/src/lib/code-graph/project-code-searcher.ts)
-- runs `count(*)` + `max("createdAt")` over one project's symbols on EVERY search
-- to decide whether its cached symbol set is still current. Without a
-- (projectId, createdAt) index that aggregate reads every row of the project.
--
-- Rollback: DROP INDEX "code_symbols_projectId_createdAt_idx";

-- CreateIndex
CREATE INDEX "code_symbols_projectId_createdAt_idx" ON "code_symbols"("projectId", "createdAt");
