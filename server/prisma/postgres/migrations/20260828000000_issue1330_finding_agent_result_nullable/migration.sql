-- Issue #1330 (ADR 0011) — make `findings.agentResultId` NULLABLE (Postgres
-- mirror). See the SQLite migration of the same name for the full rationale.
--
-- `DROP NOT NULL` is inherently idempotent (a no-op when the column is already
-- nullable), so replaying the whole chain over the cumulative init baseline —
-- which now declares the column nullable for a fresh database — never collides
-- (issue #556).
ALTER TABLE "findings" ALTER COLUMN "agentResultId" DROP NOT NULL;
