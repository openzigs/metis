-- Issue #1527 — a product records its HOME workspace, and an attached repo
-- opens the product only when the repo's project is in that workspace (or has
-- no workspace: legacy, open to all).
--
-- #1259 decided the same thing at READ time, from the creator's CURRENT
-- memberships and role. That left two holes: an admin creator "could attach"
-- every repo, so an admin-created product opened to every workspace one of
-- its repos sat in; and removing the creator from a workspace (or demoting an
-- admin creator) closed every product they made to the whole team. The home
-- is now recorded once, when the first repo the creator could have attached is
-- attached (`addProductRepo`), and never moves after that.
--
-- Nullable, not a foreign key (like `notifications.projectId`, #1447): a
-- workspace is soft-deleted, and a product homed in one stays closed to
-- non-admins rather than losing its history. The index is built after the
-- backfill, over the final values.
--
-- Rollback (documentation):
--   DROP INDEX "products_workspaceId_idx";
--   ALTER TABLE "products" DROP COLUMN "workspaceId";

-- AlterTable
ALTER TABLE "products" ADD COLUMN "workspaceId" TEXT;

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
CREATE INDEX "products_workspaceId_idx" ON "products"("workspaceId");
