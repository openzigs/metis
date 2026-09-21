/**
 * JWT issue/verify/refresh tests.
 *
 * Epic #404 (#413) — revocation state is now PERSISTENT (a Prisma-backed store).
 * These unit tests inject an in-memory store double via `setRevocationStore` so
 * they never touch a live database. A "server restart" is simulated by building
 * a FRESH `InMemoryRevocationStore` view over the SAME backing maps (the data
 * the DB would still hold) and re-installing it — if revocation truly persisted,
 * the revoked token stays rejected after the swap.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import {
  issueTokens,
  refreshAccessToken,
  revokeRefreshToken,
  revokeAllUserSessions,
  isUserDisabled,
  enableUser,
  parseExpiryToSeconds,
  pruneExpiredRevocations,
  setRevocationStore,
  verifyAccessToken,
  verifyRefreshToken,
} from "../src/lib/auth/jwt.js";
import type { RevocationStore } from "../src/lib/auth/revocation-store.js";

/**
 * Shared backing data — survives a store swap, exactly like DB rows survive a
 * server restart. `restart()` returns a brand-new store reading these same maps.
 */
interface Backing {
  revoked: Map<string, { userId: string; expiresAt: Date }>;
  cutoffs: Map<string, Date>;
}

class InMemoryRevocationStore implements RevocationStore {
  constructor(private readonly db: Backing) {}

  async revokeToken(tokenId: string, userId: string, expiresAt: Date): Promise<void> {
    this.db.revoked.set(tokenId, { userId, expiresAt });
  }

  async isRevoked(tokenId: string, userId: string, issuedAt?: number): Promise<boolean> {
    if (this.db.revoked.has(tokenId)) return true;
    if (issuedAt !== undefined) {
      const cutoff = this.db.cutoffs.get(userId);
      if (cutoff && issuedAt <= Math.floor(cutoff.getTime() / 1000)) return true;
    }
    return false;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    this.db.cutoffs.set(userId, new Date());
  }

  async clearUserRevocation(userId: string): Promise<void> {
    this.db.cutoffs.delete(userId);
  }

  async isUserRevoked(userId: string): Promise<boolean> {
    return this.db.cutoffs.has(userId);
  }

  async pruneExpired(now: Date = new Date()): Promise<number> {
    let removed = 0;
    for (const [id, row] of this.db.revoked) {
      if (row.expiresAt.getTime() < now.getTime()) {
        this.db.revoked.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

let backing: Backing;

/** Simulate a server restart: fresh store, SAME backing data (= DB rows). */
function restart(): void {
  setRevocationStore(new InMemoryRevocationStore(backing));
}

beforeEach(() => {
  process.env.JWT_SECRET = "test-jwt-secret-must-be-long-enough-for-tests";
  backing = { revoked: new Map(), cutoffs: new Map() };
  setRevocationStore(new InMemoryRevocationStore(backing));
});

describe("jwt", () => {
  it("issues a verifiable access + refresh pair", async () => {
    const { accessToken, refreshToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "developer",
      permissions: ["project.read"],
    });
    const decoded = verifyAccessToken(accessToken);
    expect(decoded.userId).toBe("u1");
    expect(decoded.role).toBe("developer");
    expect(decoded.permissions).toContain("project.read");

    const refreshDecoded = await verifyRefreshToken(refreshToken);
    expect(refreshDecoded.type).toBe("refresh");
    expect(refreshDecoded.tokenId).toBeTypeOf("string");
  });

  it("rejects an access token signed with the wrong secret", () => {
    const bad = jwt.sign({ userId: "x" }, "different-secret");
    expect(() => verifyAccessToken(bad)).toThrow();
  });

  it("rejects malformed tokens", () => {
    expect(() => verifyAccessToken("not.a.jwt")).toThrow();
  });

  it("rejects an expired token", () => {
    const expired = jwt.sign(
      { userId: "u1", username: "alice", role: "reader", permissions: [] },
      "test-jwt-secret-must-be-long-enough-for-tests",
      { expiresIn: -10 },
    );
    expect(() => verifyAccessToken(expired)).toThrow();
  });

  it("refuses to authenticate using a refresh token", () => {
    const { refreshToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "reader",
      permissions: [],
    });
    expect(() => verifyAccessToken(refreshToken)).toThrow(/refresh token/i);
  });

  it("rejects a refresh token presented as an access token even before secret check", async () => {
    // type !== "refresh" guard path in verifyRefreshToken
    const notRefresh = jwt.sign(
      { userId: "u1", username: "alice", role: "reader", permissions: [], type: "access" },
      "test-jwt-secret-must-be-long-enough-for-tests",
    );
    await expect(verifyRefreshToken(notRefresh)).rejects.toThrow(/invalid token type/i);
  });

  it("revokes a refresh token after one use (rotation)", async () => {
    const { refreshToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "reader",
      permissions: [],
    });
    const newPair = await refreshAccessToken(refreshToken);
    expect(newPair.accessToken).toBeTypeOf("string");
    // The original refresh token should now be revoked.
    await expect(verifyRefreshToken(refreshToken)).rejects.toThrow(/revoked/);
    // The freshly-minted refresh token still verifies.
    await expect(verifyRefreshToken(newPair.refreshToken)).resolves.toBeTruthy();
  });

  it("revokeRefreshToken makes subsequent verification fail", async () => {
    const { refreshToken } = issueTokens({
      userId: "u1",
      username: "alice",
      role: "reader",
      permissions: [],
    });
    const decoded = await verifyRefreshToken(refreshToken);
    await revokeRefreshToken(decoded.tokenId, decoded.userId, new Date(Date.now() + 1000));
    await expect(verifyRefreshToken(refreshToken)).rejects.toThrow(/revoked/);
  });

  describe("persistence across restart (#413)", () => {
    it("a revoked token STAYS revoked after a simulated restart", async () => {
      const { refreshToken } = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      const decoded = await verifyRefreshToken(refreshToken);
      await revokeRefreshToken(decoded.tokenId, decoded.userId, new Date(Date.now() + 60_000));

      // Restart wipes in-process state; the DB-equivalent backing survives.
      restart();

      await expect(verifyRefreshToken(refreshToken)).rejects.toThrow(/revoked/);
    });

    it("a token rotated before restart cannot be reused after restart", async () => {
      const { refreshToken } = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      const rotated = await refreshAccessToken(refreshToken);

      restart();

      // Old (rotated-away) token stays dead.
      await expect(verifyRefreshToken(refreshToken)).rejects.toThrow(/revoked/);
      // New token issued before the restart still rotates correctly after it.
      const rotatedAgain = await refreshAccessToken(rotated.refreshToken);
      expect(rotatedAgain.refreshToken).toBeTypeOf("string");
      await expect(verifyRefreshToken(rotated.refreshToken)).rejects.toThrow(/revoked/);
    });

    it("a non-revoked token still verifies after restart", async () => {
      const { refreshToken } = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      restart();
      await expect(verifyRefreshToken(refreshToken)).resolves.toBeTruthy();
    });
  });

  describe("JWT_SECRET strength enforcement", () => {
    const originalEnv = process.env.NODE_ENV;
    const originalSecret = process.env.JWT_SECRET;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
      process.env.JWT_SECRET = originalSecret;
    });

    it("throws in production when JWT_SECRET is shorter than 32 bytes", () => {
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = "x".repeat(31);
      expect(() =>
        issueTokens({ userId: "u1", username: "alice", role: "reader", permissions: [] }),
      ).toThrow(/at least 32 bytes/);
    });

    it("does not throw in production when JWT_SECRET is at least 32 bytes", () => {
      process.env.NODE_ENV = "production";
      process.env.JWT_SECRET = "x".repeat(32);
      expect(() =>
        issueTokens({ userId: "u1", username: "alice", role: "reader", permissions: [] }),
      ).not.toThrow();
    });

    it("throws in production when JWT_SECRET is unset", () => {
      process.env.NODE_ENV = "production";
      delete process.env.JWT_SECRET;
      expect(() =>
        issueTokens({ userId: "u1", username: "alice", role: "reader", permissions: [] }),
      ).toThrow(/must be set to a strong value/);
    });

    it("falls back to a dev secret in local development when JWT_SECRET is the placeholder", () => {
      process.env.NODE_ENV = "development";
      process.env.JWT_SECRET = "replace-me-with-a-long-random-string";
      // Issuing succeeds (dev fallback) and the token verifies under the same secret.
      const { accessToken } = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      expect(verifyAccessToken(accessToken).userId).toBe("u1");
    });

    // Issue #1057 — the fallback is gated on a POSITIVE local-development
    // signal, so the real token-issuing path (not just the pure resolver in
    // `jwt-secret-guard.test.ts`) must fail closed everywhere else.
    it("refuses to issue tokens when NODE_ENV=staging and JWT_SECRET is unset", () => {
      process.env.NODE_ENV = "staging";
      delete process.env.JWT_SECRET;
      expect(() =>
        issueTokens({ userId: "u1", username: "alice", role: "reader", permissions: [] }),
      ).toThrow(/JWT_SECRET must be set to a strong value/);
    });

    it("refuses to issue tokens when NODE_ENV is unset and JWT_SECRET is unset", () => {
      delete process.env.NODE_ENV;
      delete process.env.JWT_SECRET;
      expect(() =>
        issueTokens({ userId: "u1", username: "alice", role: "reader", permissions: [] }),
      ).toThrow(/JWT_SECRET must be set to a strong value/);
    });

    it("refuses to verify tokens when the environment has no usable secret", () => {
      process.env.NODE_ENV = "development";
      process.env.JWT_SECRET = "x".repeat(40);
      const { accessToken } = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      process.env.NODE_ENV = "staging";
      delete process.env.JWT_SECRET;
      expect(() => verifyAccessToken(accessToken)).toThrow(/JWT_SECRET must be set/);
    });
  });

  describe("revokeAllUserSessions", () => {
    it("revokes all refresh tokens for a user (current sessions)", async () => {
      const pair1 = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      const pair2 = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      await expect(verifyRefreshToken(pair1.refreshToken)).resolves.toBeTruthy();
      await expect(verifyRefreshToken(pair2.refreshToken)).resolves.toBeTruthy();

      await revokeAllUserSessions("u1");

      await expect(verifyRefreshToken(pair1.refreshToken)).rejects.toThrow(/revoked/);
      await expect(verifyRefreshToken(pair2.refreshToken)).rejects.toThrow(/revoked/);
    });

    it("the revoke-all cutoff persists across a restart", async () => {
      const pair = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      await revokeAllUserSessions("u1");
      restart();
      await expect(verifyRefreshToken(pair.refreshToken)).rejects.toThrow(/revoked/);
    });

    it("marks user as disabled", async () => {
      expect(await isUserDisabled("u1")).toBe(false);
      await revokeAllUserSessions("u1");
      expect(await isUserDisabled("u1")).toBe(true);
    });

    it("does not affect other users' tokens", async () => {
      const alicePair = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      const bobPair = issueTokens({
        userId: "u2",
        username: "bob",
        role: "reader",
        permissions: [],
      });

      await revokeAllUserSessions("u1");

      await expect(verifyRefreshToken(alicePair.refreshToken)).rejects.toThrow(/revoked/);
      await expect(verifyRefreshToken(bobPair.refreshToken)).resolves.toBeTruthy();
    });

    it("a token issued AFTER re-enable is accepted (reprovision flow)", async () => {
      await revokeAllUserSessions("u1");
      await enableUser("u1");
      // New login after re-enable — `iat` is strictly after the (cleared) cutoff.
      const fresh = issueTokens({
        userId: "u1",
        username: "alice",
        role: "reader",
        permissions: [],
      });
      await expect(verifyRefreshToken(fresh.refreshToken)).resolves.toBeTruthy();
    });

    it("enableUser re-enables a disabled user", async () => {
      await revokeAllUserSessions("u1");
      expect(await isUserDisabled("u1")).toBe(true);
      await enableUser("u1");
      expect(await isUserDisabled("u1")).toBe(false);
    });
  });

  describe("pruneExpiredRevocations (TTL)", () => {
    it("removes only rows whose token has expired", async () => {
      await revokeRefreshToken("expired-1", "u1", new Date(Date.now() - 1000));
      await revokeRefreshToken("expired-2", "u1", new Date(Date.now() - 5000));
      await revokeRefreshToken("live-1", "u1", new Date(Date.now() + 60_000));

      const removed = await pruneExpiredRevocations();
      expect(removed).toBe(2);
      // The still-live revocation remains enforced.
      expect(backing.revoked.has("live-1")).toBe(true);
      expect(backing.revoked.has("expired-1")).toBe(false);
    });
  });

  describe("revokeRefreshToken defaults", () => {
    it("derives a TTL'd expiry from the refresh window when none is supplied", async () => {
      // No userId / expiresAt → defaults to "unknown" + now + refresh TTL (~7d).
      await revokeRefreshToken("bare-token");
      const row = backing.revoked.get("bare-token");
      expect(row).toBeDefined();
      expect(row?.userId).toBe("unknown");
      // 7 days out (allow generous slack for clock + parse).
      expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * 24 * 60 * 60 * 1000);
    });
  });

  describe("parseExpiryToSeconds", () => {
    it.each([
      ["7d", 7 * 24 * 60 * 60],
      ["1h", 60 * 60],
      ["30m", 30 * 60],
      ["2w", 2 * 7 * 24 * 60 * 60],
      ["45s", 45],
      ["3600", 3600], // bare number → seconds
    ])("parses %s", (input, expected) => {
      expect(parseExpiryToSeconds(input)).toBe(expected);
    });

    it("falls back to the 7-day default for an unparseable value", () => {
      expect(parseExpiryToSeconds("not-a-duration")).toBe(7 * 24 * 60 * 60);
    });
  });
});
