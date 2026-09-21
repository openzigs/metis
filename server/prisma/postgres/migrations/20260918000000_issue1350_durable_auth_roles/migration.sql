ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "authRolesInitializedAt" TIMESTAMP(3);

-- Preserve legacy revocations. NULL is reserved for post-migration accounts.
UPDATE "users" SET "authRolesInitializedAt" = CURRENT_TIMESTAMP
  WHERE "authRolesInitializedAt" IS NULL;

ALTER TABLE "user_roles"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS "user_roles_userId_source_idx"
  ON "user_roles" ("userId", "source");