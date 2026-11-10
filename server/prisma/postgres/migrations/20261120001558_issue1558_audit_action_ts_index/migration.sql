-- Issue #1558 — the (`action`, `ts`) index on `audit_logs` (Postgres twin of
-- server/prisma/migrations/20261120001558_issue1558_audit_action_ts_index; see
-- that file for the rationale). One index, nothing backfilled. Building it
-- blocks writes to `audit_logs` for as long as the build takes, which grows with
-- the table: audit writes are queued in memory (`audit-service.ts`) and resume
-- after. Idempotent (#556).
--
-- Rollback: server/prisma/postgres/rollbacks/20261120001558_issue1558_audit_action_ts_index.sql

-- CreateIndex
CREATE INDEX IF NOT EXISTS "audit_logs_action_ts_idx" ON "audit_logs"("action", "ts");
