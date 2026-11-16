-- Issue #2566 (epic #2564) — a per-project override for the analysis code
-- pass mode (#2565).
--
-- "projects"."codeExploration" (TEXT, NOT NULL, default 'auto'): `auto` defers
-- to the platform key ANALYSIS_CODE_EXPLORATION; `explore` / `fast` override
-- it. Every existing row reads `auto`.
--
-- Rollback: server/prisma/postgres/rollbacks/20261201002566_issue2566_project_code_exploration.sql
-- (applied and re-applied over a seeded project by the postgres-migrate-deploy CI job).

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "codeExploration" TEXT NOT NULL DEFAULT 'auto';
