-- Issue #792 — attribution columns on the project usage ledger.
--
-- The project usage page read two tables: the cards from `token_usages`, the
-- "Detailed Usage Analytics" card and its CSV export from `ai_token_usages`.
-- The two held disjoint traffic, so one page showed 10.8M tokens / $5.57 and
-- 290k / $0.14 side by side. Every number on the page now comes from
-- `token_usages`, which needs the two dimensions the detail view groups by and
-- `ai_token_usages` alone carried: who a call is billed to, and which pipeline
-- step spent it.
--
-- Additive only: two nullable TEXT columns. Existing rows read NULL and are
-- shown as "unknown" step / unattributed user — exactly what they were.
-- `userId` deliberately has no FK: spend must outlive the user who caused it.
--
-- Rollback (documentation):
--   ALTER TABLE "token_usages" DROP COLUMN "agentStep";
--   ALTER TABLE "token_usages" DROP COLUMN "userId";
-- Lossy only for the attribution of rows written since; tokens and cost stay.
ALTER TABLE "token_usages" ADD COLUMN "userId" TEXT;
ALTER TABLE "token_usages" ADD COLUMN "agentStep" TEXT;
