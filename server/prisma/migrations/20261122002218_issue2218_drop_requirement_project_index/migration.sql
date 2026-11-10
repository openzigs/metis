-- Issue #2218 — drop the (`projectId`) index on `requirements`. #2209 added a
-- (`projectId`, `createdAt`, `id`) index, which serves every read by `projectId`
-- alone as well, so the single-column one only cost writes. Nothing else changes.
--
-- Rollback: server/prisma/rollbacks/20261122002218_issue2218_drop_requirement_project_index.sql
-- (exercised by server/tests/requirement-project-index-drop-2218.sqlite.test.ts).

-- DropIndex
DROP INDEX "requirements_projectId_idx";
