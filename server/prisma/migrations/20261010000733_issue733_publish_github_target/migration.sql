-- Issue #733 — a persisted per-project GitHub publish target.
--
-- Every publish surface used to default to the repo connector's own repository,
-- which for an analysed open-source project is its upstream. These two columns
-- hold the owner/repo issues are published to instead; both null means "not
-- configured" and the publish forms start empty rather than upstream.
--
-- Additive only: two nullable columns, nothing backfilled.
--
-- Rollback (documentation):
--   ALTER TABLE "projects" DROP COLUMN "publishGithubOwner";
--   ALTER TABLE "projects" DROP COLUMN "publishGithubRepo";
-- Lossy only for the configured target, which users can re-enter.
ALTER TABLE "projects" ADD COLUMN "publishGithubOwner" TEXT;
ALTER TABLE "projects" ADD COLUMN "publishGithubRepo" TEXT;
