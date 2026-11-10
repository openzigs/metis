-- Issue #2209 — the (`projectId`, `createdAt`, `id`) index on `requirements`
-- (Postgres twin of server/prisma/migrations/20261121002209_issue2209_requirement_picker_index;
-- see that file for the rationale). One index, nothing backfilled. Building it
-- blocks writes to `requirements` for as long as the build takes, which grows
-- with the table. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261121002209_issue2209_requirement_picker_index.sql

-- CreateIndex
CREATE INDEX IF NOT EXISTS "requirements_projectId_createdAt_id_idx" ON "requirements"("projectId", "createdAt", "id");
