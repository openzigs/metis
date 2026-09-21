-- Epic #404 (#413) — Persistent refresh-token revocation/rotation.
--
-- Moves the previously in-memory revocation state out of `lib/auth/jwt.ts` into
-- two persistent tables so a server restart no longer wipes it and force-logs-out
-- every user (the #1 root cause of the epic's "logged out without knowing"
-- symptom). Both tables are NEW and additive — no existing table is touched, so
-- this migration is non-destructive and trivially reversible (DROP the two
-- tables).
--
--   * revoked_refresh_tokens     — one row per individually-revoked refresh token
--                                  (single-use rotation, explicit logout). Stores
--                                  ONLY the ULID `tokenId` (NOT a secret), never
--                                  the raw JWT. `tokenId` is UNIQUE + indexed so
--                                  the per-request revocation check is an O(1)
--                                  point lookup, not a scan. `expiresAt` mirrors
--                                  the refresh-token TTL so expired rows can be
--                                  pruned (bounded growth).
--   * user_session_revocations   — one per-user `cutoff` timestamp powering
--                                  revokeAllUserSessions WITHOUT a write on every
--                                  token issuance: any refresh token whose `iat`
--                                  is at/before the cutoff is rejected.

-- CreateTable
CREATE TABLE "revoked_refresh_tokens" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "revokedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "user_session_revocations" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "cutoff" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "revoked_refresh_tokens_tokenId_key" ON "revoked_refresh_tokens"("tokenId");

-- CreateIndex
CREATE INDEX "revoked_refresh_tokens_userId_idx" ON "revoked_refresh_tokens"("userId");

-- CreateIndex
CREATE INDEX "revoked_refresh_tokens_expiresAt_idx" ON "revoked_refresh_tokens"("expiresAt");
