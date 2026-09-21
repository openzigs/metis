ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "authRoleAuthority" TEXT NOT NULL DEFAULT 'unknown';

-- Preserve all assignments and initialization timestamps. Only positive SCIM
-- evidence establishes authority, including historical provisioning with no roles.
-- Group audits target roles, not users, and cannot identify former members.
-- Generic user.updated audits recorded only an operation count, including profile-only edits.
UPDATE "users"
SET "authRoleAuthority" = 'scim'
WHERE EXISTS (
  SELECT 1 FROM "user_roles"
  WHERE "user_roles"."userId" = "users"."id" AND "user_roles"."source" = 'scim'
) OR EXISTS (
  SELECT 1 FROM "audit_logs"
  WHERE "audit_logs"."targetId" = "users"."id"
    AND "audit_logs"."targetType" = 'user'
    AND "audit_logs"."action" IN ('scim.user.created', 'scim.user.deleted')
);