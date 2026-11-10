-- Issue #2209 — a (`projectId`, `createdAt`, `id`) index on `requirements`. The
-- discussion requirement picker (`server/src/lib/discussions/requirement-search.ts`)
-- reads a project's live requirements newest first, id as the tie-break, and
-- stops at 20 matches; with only the (`projectId`) index every keystroke sorted
-- the whole project. One index, no column, nothing backfilled.
--
-- Rollback: server/prisma/rollbacks/20261121002209_issue2209_requirement_picker_index.sql
-- (exercised by server/tests/requirement-picker-index-migration-2209.sqlite.test.ts).

-- CreateIndex
CREATE INDEX "requirements_projectId_createdAt_id_idx" ON "requirements"("projectId", "createdAt", "id");
