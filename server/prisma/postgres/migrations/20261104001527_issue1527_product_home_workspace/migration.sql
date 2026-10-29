-- Issue #1527 — a product records its home workspace. Postgres twin of the
-- SQLite migration; see that file
-- (server/prisma/migrations/20261104001527_issue1527_product_home_workspace)
-- for the full rationale. Nullable, not a foreign key, backfilled from the
-- earliest-attached repo the product's creator could have attached.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty;
-- the backfill writes only rows still NULL, so a re-run is a no-op. The index
-- is built after the backfill.
--
-- Rollback (documentation):
--   DROP INDEX "products_workspaceId_idx";
--   ALTER TABLE "products" DROP COLUMN "workspaceId";

-- AlterTable
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "workspaceId" TEXT;

-- Backfill: the earliest-attached repo (by attach time, then row id) whose
-- project sits in a workspace and that the product's CREATOR could have
-- attached: the creator holds a membership row in that workspace, or is a
-- system admin. "Admin" is the role the login path resolves
-- (`resolveEffectiveRoleFromRows`): an `admin` role row counts unless it came
-- from the identity provider and the user carries an explicit override (a
-- non-provider role row, or authority scim | explicit | revoked). Only rows
-- still NULL are written, and a product with no such repo stays NULL, so its
-- workspace repos open it to no non-admin — what #1259's read-time rule
-- already answered for it.
UPDATE "products" SET "workspaceId" = (
  SELECT "p"."workspaceId"
  FROM "product_repos" "pr"
  JOIN "repo_connections" "rc" ON "rc"."id" = "pr"."repoConnectionId"
  JOIN "projects" "p" ON "p"."id" = "rc"."projectId"
  WHERE "pr"."productId" = "products"."id"
    AND "p"."workspaceId" IS NOT NULL
    AND (
      EXISTS (
        SELECT 1 FROM "workspace_members" "wm"
        WHERE "wm"."workspaceId" = "p"."workspaceId"
          AND "wm"."userId" = "products"."createdById"
      )
      OR EXISTS (
        SELECT 1
        FROM "user_roles" "ur"
        JOIN "roles" "r" ON "r"."id" = "ur"."roleId"
        JOIN "users" "u" ON "u"."id" = "ur"."userId"
        WHERE "ur"."userId" = "products"."createdById"
          AND "r"."key" = 'admin'
          AND (
            "ur"."source" <> 'provider'
            OR NOT (
              "u"."authRoleAuthority" IN ('scim', 'explicit', 'revoked')
              OR EXISTS (
                SELECT 1 FROM "user_roles" "x"
                WHERE "x"."userId" = "ur"."userId" AND "x"."source" <> 'provider'
              )
            )
          )
      )
    )
  ORDER BY "pr"."createdAt", "pr"."id"
  LIMIT 1
)
WHERE "workspaceId" IS NULL;

-- CreateIndex (after the backfill)
CREATE INDEX IF NOT EXISTS "products_workspaceId_idx" ON "products"("workspaceId");
