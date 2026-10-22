-- Issue #1395 — a local user is keyed on the identity that signs in as it, not
-- on the username alone.
--
-- Both login paths (`routes/auth.ts`, `routes/sso.ts`) upserted the user on
-- `username`, across providers, so an OIDC user whose `preferred_username`
-- matched an LDAP user's name signed in as that LDAP account — its roles,
-- workspaces and data. `user_identities` records each (provider, issuer,
-- subject) bound to a user; a login is looked up by that key first, and a
-- username already bound to another provider's identity refuses the sign-in
-- (`server/src/lib/auth/login-identity.ts`).
--
-- `users.authSource` records the provider kind an account belongs to. Existing
-- rows are backfilled from what the database knows: a user whose every recorded
-- login (`audit_logs`, action `user.login`) came through one SSO mode gets that
-- mode. Everything else stays NULL = legacy, which only the deployment's
-- AUTH_MODE provider may claim by username on its next sign-in — the provider
-- that created those rows before SSO could be configured beside it.
--
-- Rollback (documentation):
--   DROP TABLE "user_identities";
--   ALTER TABLE "users" DROP COLUMN "authSource";
-- After it every provider matches users by username again (the #1395 defect).

-- AlterTable
ALTER TABLE "users" ADD COLUMN "authSource" TEXT;

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "linkedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" DATETIME,
    CONSTRAINT "user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "user_identities_userId_idx" ON "user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_issuer_subject_key" ON "user_identities"("provider", "issuer", "subject");

-- Backfill: a user every one of whose logins came through OIDC belongs to OIDC.
UPDATE "users" SET "authSource" = 'oidc'
WHERE "authSource" IS NULL
  AND EXISTS (
    SELECT 1 FROM "audit_logs" a
    WHERE a."actorId" = "users"."id" AND a."action" = 'user.login'
      AND a."metadata" LIKE '%"mode":"oidc"%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "audit_logs" a
    WHERE a."actorId" = "users"."id" AND a."action" = 'user.login'
      AND (a."metadata" IS NULL OR a."metadata" NOT LIKE '%"mode":"oidc"%')
  );

-- Backfill: likewise for SAML.
UPDATE "users" SET "authSource" = 'saml'
WHERE "authSource" IS NULL
  AND EXISTS (
    SELECT 1 FROM "audit_logs" a
    WHERE a."actorId" = "users"."id" AND a."action" = 'user.login'
      AND a."metadata" LIKE '%"mode":"saml"%'
  )
  AND NOT EXISTS (
    SELECT 1 FROM "audit_logs" a
    WHERE a."actorId" = "users"."id" AND a."action" = 'user.login'
      AND (a."metadata" IS NULL OR a."metadata" NOT LIKE '%"mode":"saml"%')
  );
