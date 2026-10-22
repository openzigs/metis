-- Issue #1395 — a local user is keyed on the identity that signs in as it, not
-- on the username alone. Postgres twin of the SQLite migration; see that file
-- (server/prisma/migrations/20261025001395_issue1395_user_identities) for the
-- full rationale.
--
-- `user_identities` records each (provider, issuer, subject) bound to a user; a
-- login is looked up by that key first, and a username already bound to another
-- provider's identity refuses the sign-in. `users.authSource` records the
-- provider kind an account belongs to: a user whose every recorded login came
-- through one SSO mode is backfilled to that mode, a SCIM-provisioned one to
-- `scim`, the rest stay NULL = legacy,
-- which only the deployment's AUTH_MODE provider may claim by username.
--
-- Structural DDL is idempotent (#556), so the full history applies from empty.
--
-- Rollback (documentation):
--   DROP TABLE "user_identities";
--   ALTER TABLE "users" DROP COLUMN "authSource";

-- AlterTable
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "authSource" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "user_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "linkedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastLoginAt" TIMESTAMP(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_identities_userId_idx" ON "user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "user_identities_provider_issuer_subject_key" ON "user_identities"("provider", "issuer", "subject");

-- AddForeignKey
DO $idem$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_identities_userId_fkey') THEN
    EXECUTE 'ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE';
  END IF;
END
$idem$;

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

-- Backfill: an account SCIM provisioned (and no SSO login above placed) is the
-- IdP's: the AUTH_MODE provider claims it by username at first sign-in,
-- without the verified-e-mail gate that applies to rows of unknown provenance.
UPDATE "users" SET "authSource" = 'scim'
WHERE "authSource" IS NULL AND "authRoleAuthority" = 'scim';
