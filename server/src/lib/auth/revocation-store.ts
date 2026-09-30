/**
 * Persistent refresh-token revocation store (Epic #404, #413).
 *
 * Replaces the in-memory `revokedTokens` Set / `userTokenMap` Map / `disabledUsers`
 * Set that previously lived in `jwt.ts`. Those structures were wiped on every
 * server restart, which silently broke refresh-token rotation and force-logged
 * out every user — the #1 root cause of the epic's "logged out without knowing"
 * symptom.
 *
 * Two backing tables (see `prisma/schema.prisma`):
 *   - `revoked_refresh_tokens`     — one row per individually-revoked tokenId
 *                                    (single-use rotation, explicit logout).
 *   - `user_session_revocations`   — one per-user `cutoff` timestamp; any refresh
 *                                    token issued at/before the cutoff is rejected.
 *                                    This is how `revokeAllUserSessions` works
 *                                    WITHOUT a DB write on every token issuance.
 *
 * Security (OWASP):
 *   - Only the `tokenId` (a ULID, NOT a secret) is stored — never the raw JWT.
 *   - The store NEVER logs token values.
 *   - Reads FAIL CLOSED: if the DB read throws, the caller treats the token as
 *     revoked/unverifiable rather than accepting it (see `isRevoked`).
 *
 * The store is a thin adapter around the Prisma client singleton so unit tests
 * can mock `../prisma.js` and exercise persistence (a "restart" is simulated by
 * re-reading the same backing rows from a fresh store instance) without a live
 * database.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { isUniqueViolation } from "../db/prisma-errors.js";

const log = createChildLogger("revocation-store");

export interface RevocationStore {
  /** Mark a single refresh token (by its ULID tokenId) as revoked. */
  revokeToken(tokenId: string, userId: string, expiresAt: Date): Promise<void>;
  /**
   * #582 — atomically revoke a refresh token IF it is not already revoked.
   * Returns `true` only to the one caller that recorded the revocation; every
   * other caller (a concurrent refresh with the same token, or a token already
   * revoked by logout) gets `false`. Refresh rotation proceeds only on `true`,
   * so one refresh token can never mint two token pairs.
   */
  claimToken(tokenId: string, userId: string, expiresAt: Date, claimedAt?: Date): Promise<boolean>;
  /**
   * #582 — undo a claim this caller won, so the presented refresh token stays
   * redeemable after a transient fault stopped the rotation. Deletes only the
   * row the claim inserted — matched on `tokenId` AND the `claimedAt` passed to
   * `claimToken` — so it cannot undo a logout's `revokeToken`, which restamps
   * `revokedAt` on a row it finds. Throws if the delete fails.
   */
  releaseClaim(tokenId: string, claimedAt: Date): Promise<void>;
  /**
   * True if the given refresh token must be rejected. Considers BOTH an explicit
   * per-token revocation AND the user's session cutoff (revoke-all). `issuedAt`
   * is the refresh token's `iat` claim (seconds since epoch); pass `undefined`
   * to skip the cutoff check (e.g. when the claim is absent).
   *
   * FAILS CLOSED: returns `true` if the backing reads throw, so a transient DB
   * error can never widen the window in which a revoked token is accepted.
   */
  isRevoked(tokenId: string, userId: string, issuedAt?: number): Promise<boolean>;
  /**
   * #582 — true if a token issued at `issuedAt` (seconds) falls at/before the
   * user's session cutoff, ignoring any per-token revocation. Refresh rotation
   * re-checks this AFTER `claimToken` (which has itself just revoked the token,
   * so `isRevoked` can no longer answer), so a SCIM deprovision that lands
   * between the first check and the claim still refuses the new pair.
   *
   * Unlike `isRevoked` it does NOT swallow a read error — it rethrows, so the
   * caller (which has already claimed the token) can release the claim and
   * report a retryable failure instead of burning the token on a DB blip. The
   * caller must treat a throw as "do not issue".
   */
  isCutOff(userId: string, issuedAt: number): Promise<boolean>;
  /**
   * Revoke every CURRENT session for a user by recording a cutoff = now. Tokens
   * issued strictly AFTER this instant (e.g. after re-provisioning) still pass.
   */
  revokeAllForUser(userId: string): Promise<void>;
  /** Clear a user's session cutoff so future logins are honoured immediately. */
  clearUserRevocation(userId: string): Promise<void>;
  /** True if the user currently has an active session-revocation cutoff. */
  isUserRevoked(userId: string): Promise<boolean>;
  /** Delete revoked-token rows whose `expiresAt` is in the past. Returns count. */
  pruneExpired(now?: Date): Promise<number>;
}

/**
 * Prisma-backed implementation. Stateless — safe to instantiate per-call or as a
 * shared singleton; all state lives in the database, which is the entire point.
 */
export class PrismaRevocationStore implements RevocationStore {
  async revokeToken(tokenId: string, userId: string, expiresAt: Date): Promise<void> {
    // Idempotent: re-revoking an already-revoked token (e.g. double logout) is
    // not a unique-constraint error. #582 — the update restamps `revokedAt`, so a
    // refresh claim released afterwards (`releaseClaim` matches on the claim's
    // own `revokedAt`) no longer matches and cannot undo this revocation.
    const now = new Date();
    await prisma.revokedRefreshToken.upsert({
      where: { tokenId },
      update: { revokedAt: now },
      create: { tokenId, userId, expiresAt, revokedAt: now },
    });
  }

  async claimToken(
    tokenId: string,
    userId: string,
    expiresAt: Date,
    claimedAt: Date = new Date(),
  ): Promise<boolean> {
    // An insert-unique on `tokenId`: the database's unique index serialises
    // concurrent inserts, so exactly one succeeds and the rest see P2002. A
    // check-then-write here would reopen the race this method exists to close.
    try {
      await prisma.revokedRefreshToken.create({
        data: { tokenId, userId, expiresAt, revokedAt: claimedAt },
      });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  async releaseClaim(tokenId: string, claimedAt: Date): Promise<void> {
    // `deleteMany` so a row that no longer matches (restamped by a logout, or
    // already pruned) is a zero-count no-op rather than a not-found error.
    await prisma.revokedRefreshToken.deleteMany({ where: { tokenId, revokedAt: claimedAt } });
  }

  async isCutOff(userId: string, issuedAt: number): Promise<boolean> {
    const marker = await prisma.userSessionRevocation.findUnique({
      where: { userId },
      select: { cutoff: true },
    });
    return marker !== null && issuedAt <= Math.floor(marker.cutoff.getTime() / 1000);
  }

  async isRevoked(tokenId: string, userId: string, issuedAt?: number): Promise<boolean> {
    try {
      const explicit = await prisma.revokedRefreshToken.findUnique({
        where: { tokenId },
        select: { tokenId: true },
      });
      if (explicit) {
        return true;
      }
      if (issuedAt !== undefined) {
        const marker = await prisma.userSessionRevocation.findUnique({
          where: { userId },
          select: { cutoff: true },
        });
        // `iat` is in whole seconds; compare against the cutoff in seconds so a
        // token issued in the same second as the cutoff is treated as revoked.
        if (marker && issuedAt <= Math.floor(marker.cutoff.getTime() / 1000)) {
          return true;
        }
      }
      return false;
    } catch (err) {
      // Fail closed — never accept a token we could not verify against the store.
      log.error("revocation store read failed; treating token as revoked", {
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  async revokeAllForUser(userId: string): Promise<void> {
    const now = new Date();
    await prisma.userSessionRevocation.upsert({
      where: { userId },
      update: { cutoff: now },
      create: { userId, cutoff: now },
    });
  }

  async clearUserRevocation(userId: string): Promise<void> {
    await prisma.userSessionRevocation.delete({ where: { userId } }).catch(() => {
      // No marker to clear — already enabled. Swallow the not-found.
    });
  }

  async isUserRevoked(userId: string): Promise<boolean> {
    const marker = await prisma.userSessionRevocation.findUnique({
      where: { userId },
      select: { userId: true },
    });
    return marker !== null;
  }

  async pruneExpired(now: Date = new Date()): Promise<number> {
    const result = await prisma.revokedRefreshToken.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}

/** Shared singleton used by `jwt.ts`. */
export const revocationStore: RevocationStore = new PrismaRevocationStore();

/** Handle for the recurring prune job — call `stop()` on shutdown. */
export interface RevocationPrunerHandle {
  stop(): void;
}

/** Default prune cadence: hourly. Revoked rows are tiny; hourly is plenty. */
const DEFAULT_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

/**
 * Start the recurring expired-row pruner. Mirrors the FinOps lifecycle pattern
 * (`setInterval` + `unref` + a handle with `stop()`), so the interval never
 * keeps the event loop alive on its own.
 */
export function startRevocationPruner(
  intervalMs = DEFAULT_PRUNE_INTERVAL_MS,
  target: RevocationStore = revocationStore,
): RevocationPrunerHandle {
  const timer = setInterval(() => {
    target.pruneExpired().catch((err: unknown) => {
      log.error("revocation prune run failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  log.info("revocation pruner started", { intervalMs });
  return {
    stop() {
      clearInterval(timer);
      log.info("revocation pruner stopped");
    },
  };
}
