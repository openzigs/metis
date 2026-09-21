ALTER TABLE "users"
  ADD COLUMN "authRolesInitializedAt" DATETIME;

-- A legacy empty assignment set may represent intentional revocation.
-- Only accounts created after this migration may bootstrap provider grants.
UPDATE "users" SET "authRolesInitializedAt" = CURRENT_TIMESTAMP;

ALTER TABLE "user_roles"
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'unknown';

CREATE INDEX "user_roles_userId_source_idx"
  ON "user_roles" ("userId", "source");