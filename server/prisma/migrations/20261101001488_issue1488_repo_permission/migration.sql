-- Issue #1488 — a connector takes deliveries signed with the shared
-- GITHUB_WEBHOOK_SECRET only when its credential can write to the repository.
--
--   repoPermission  the permission GitHub reported for the connector's token at
--                   its last successful Test or scheduled refresh: admin | push
--                   | read | none (no token). Only admin or push is eligible
--                   for shared-secret pull request routing. `connected` alone
--                   proved only that the repository could be read, which a
--                   public repository allows with no credential at all, so a
--                   tenant in another workspace could take the deliveries.
--
-- Not backfilled: no existing row records which credential its Test used, so
-- every existing connector is NULL, and ineligible, until it is tested again
-- (its next scheduled refresh, or a click on Test).
--
-- Rollback (documentation):
--   ALTER TABLE "repo_connections" DROP COLUMN "repoPermission";

-- AlterTable
ALTER TABLE "repo_connections" ADD COLUMN "repoPermission" TEXT;
