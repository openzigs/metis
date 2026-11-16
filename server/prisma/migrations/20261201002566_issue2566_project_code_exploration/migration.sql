-- Issue #2566 (epic #2564) — a per-project override for the analysis code
-- pass mode (#2565).
--
-- "projects"."codeExploration" (TEXT, NOT NULL, default 'auto'): `auto` defers
-- to the platform key ANALYSIS_CODE_EXPLORATION; `explore` / `fast` override
-- it. Every existing row reads `auto`, so nothing changes until someone sets it.
--
-- Rollback: server/prisma/rollbacks/20261201002566_issue2566_project_code_exploration.sql
-- (exercised by server/tests/project-code-exploration-2566.sqlite.test.ts).

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "codeExploration" TEXT NOT NULL DEFAULT 'auto';
