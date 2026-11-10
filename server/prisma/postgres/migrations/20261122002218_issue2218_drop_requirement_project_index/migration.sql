-- Issue #2218 — drop the (`projectId`) index on `requirements` (Postgres twin of
-- server/prisma/migrations/20261122002218_issue2218_drop_requirement_project_index;
-- see that file for the rationale). The (`projectId`, `createdAt`, `id`) index
-- from #2209 serves the same reads. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261122002218_issue2218_drop_requirement_project_index.sql

-- DropIndex
DROP INDEX IF EXISTS "requirements_projectId_idx";
