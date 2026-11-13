-- Issue #2436 — maker-checker for requirement approval.
--
-- "projects"."allowSelfApproval" (BOOLEAN NOT NULL DEFAULT false): off, the
-- author of a requirement cannot approve it directly and the requester of a
-- review cannot sign it off; on, a solo analyst may (still only with the
-- `requirement.approve` permission). Every existing project reads false, the
-- strict default the owner chose.
--
-- Rollback: server/prisma/postgres/rollbacks/20261127002436_issue2436_allow_self_approval.sql

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "allowSelfApproval" BOOLEAN NOT NULL DEFAULT false;
