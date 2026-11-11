-- Issue #2222 — governing findings record the requirement versions they judged
-- (Postgres twin of server/prisma/migrations/20261123002222_issue2222_governing_finding_requirement_versions;
-- see that file for the rationale). Existing rows read null. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261123002222_issue2222_governing_finding_requirement_versions.sql

-- AlterTable
ALTER TABLE "governing_findings" ADD COLUMN IF NOT EXISTS "requirementVersions" TEXT;
