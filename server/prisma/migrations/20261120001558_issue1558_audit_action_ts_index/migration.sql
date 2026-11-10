-- Issue #1558 — an (`action`, `ts`) index on `audit_logs`. The admin
-- Authentication page's SAML group-overage warning reads one action in the last
-- 30 days, newest first (`server/src/lib/auth/saml-group-overage.ts`); with only
-- the (`ts`) and (`targetType`, `targetId`, `action`) indexes that read walked
-- the whole audit table. One index, no column, nothing backfilled.
--
-- Rollback: server/prisma/rollbacks/20261120001558_issue1558_audit_action_ts_index.sql
-- (exercised by server/tests/audit-action-ts-index-migration-1558.sqlite.test.ts).

-- CreateIndex
CREATE INDEX "audit_logs_action_ts_idx" ON "audit_logs"("action", "ts");
