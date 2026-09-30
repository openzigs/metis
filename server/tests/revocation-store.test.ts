/**
 * Tests for the persistent refresh-token revocation store (Epic #404, #413).
 *
 * Exercises the REAL `PrismaRevocationStore` against a mocked `prisma` client
 * (the established `vi.mock("../src/lib/prisma.js")` pattern — no live DB). The
 * mock is a faithful in-memory stand-in for the two Prisma models so we verify
 * the store's query shapes, idempotency, fail-closed behaviour, and pruning.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface RevokedRow {
  id: string;
  tokenId: string;
  userId: string;
  revokedAt: Date;
  expiresAt: Date;
}
interface CutoffRow {
  userId: string;
  cutoff: Date;
  updatedAt: Date;
}

const revoked = new Map<string, RevokedRow>();
const cutoffs = new Map<string, CutoffRow>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    revokedRefreshToken: {
      upsert: vi.fn(
        async ({
          where,
          create,
        }: {
          where: { tokenId: string };
          create: { tokenId: string; userId: string; expiresAt: Date };
        }) => {
          const existing = revoked.get(where.tokenId);
          if (existing) return existing; // update {} — no-op
          nextId += 1;
          const row: RevokedRow = {
            id: `rrt_${nextId}`,
            tokenId: create.tokenId,
            userId: create.userId,
            expiresAt: create.expiresAt,
            revokedAt: new Date(),
          };
          revoked.set(row.tokenId, row);
          return row;
        },
      ),
      // The `tokenId @unique` index: a second insert of one tokenId rejects
      // with Prisma's unique-violation code, which is what makes it atomic.
      create: vi.fn(
        async ({ data }: { data: { tokenId: string; userId: string; expiresAt: Date } }) => {
          if (revoked.has(data.tokenId)) {
            throw Object.assign(new Error("Unique constraint failed on the fields: (`tokenId`)"), {
              code: "P2002",
            });
          }
          nextId += 1;
          const row: RevokedRow = { id: `rrt_${nextId}`, ...data, revokedAt: new Date() };
          revoked.set(row.tokenId, row);
          return row;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { tokenId: string } }) => {
        return revoked.get(where.tokenId) ?? null;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
        let count = 0;
        for (const [id, row] of revoked) {
          if (row.expiresAt.getTime() < where.expiresAt.lt.getTime()) {
            revoked.delete(id);
            count += 1;
          }
        }
        return { count };
      }),
    },
    userSessionRevocation: {
      upsert: vi.fn(
        async ({
          where,
          update,
          create,
        }: {
          where: { userId: string };
          update: { cutoff: Date };
          create: { userId: string; cutoff: Date };
        }) => {
          const existing = cutoffs.get(where.userId);
          if (existing) {
            existing.cutoff = update.cutoff;
            existing.updatedAt = new Date();
            return existing;
          }
          const row: CutoffRow = {
            userId: create.userId,
            cutoff: create.cutoff,
            updatedAt: new Date(),
          };
          cutoffs.set(row.userId, row);
          return row;
        },
      ),
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => {
        return cutoffs.get(where.userId) ?? null;
      }),
      delete: vi.fn(async ({ where }: { where: { userId: string } }) => {
        const existing = cutoffs.get(where.userId);
        if (!existing) {
          // Mirror Prisma's behaviour: deleting a missing row rejects.
          throw new Error("Record to delete does not exist.");
        }
        cutoffs.delete(where.userId);
        return existing;
      }),
    },
  },
}));

// Import AFTER the mock is registered.
import {
  PrismaRevocationStore,
  startRevocationPruner,
  type RevocationStore,
} from "../src/lib/auth/revocation-store.js";
import { prisma } from "../src/lib/prisma.js";

let store: PrismaRevocationStore;

beforeEach(() => {
  revoked.clear();
  cutoffs.clear();
  nextId = 0;
  store = new PrismaRevocationStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("PrismaRevocationStore — single token revocation", () => {
  it("revokes a token and reports it revoked", async () => {
    await store.revokeToken("tok-1", "u1", new Date(Date.now() + 60_000));
    expect(await store.isRevoked("tok-1", "u1")).toBe(true);
  });

  it("reports a never-revoked token as NOT revoked", async () => {
    expect(await store.isRevoked("tok-unknown", "u1")).toBe(false);
  });

  it("revokeToken is idempotent (double logout does not throw)", async () => {
    const exp = new Date(Date.now() + 60_000);
    await store.revokeToken("tok-1", "u1", exp);
    await expect(store.revokeToken("tok-1", "u1", exp)).resolves.toBeUndefined();
    expect(revoked.size).toBe(1);
  });
});

describe("PrismaRevocationStore — claimToken (#582 atomic revoke-if-not-revoked)", () => {
  const exp = () => new Date(Date.now() + 60_000);

  it("the first claim wins and records the revocation", async () => {
    expect(await store.claimToken("tok-1", "u1", exp())).toBe(true);
    expect(await store.isRevoked("tok-1", "u1")).toBe(true);
    expect(revoked.get("tok-1")?.userId).toBe("u1");
  });

  it("a second claim of the same token loses", async () => {
    await store.claimToken("tok-1", "u1", exp());
    expect(await store.claimToken("tok-1", "u1", exp())).toBe(false);
    expect(revoked.size).toBe(1);
  });

  it("two concurrent claims of one token: exactly one wins", async () => {
    const results = await Promise.all([
      store.claimToken("tok-1", "u1", exp()),
      store.claimToken("tok-1", "u1", exp()),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("a claim of an already-revoked (logged-out) token loses", async () => {
    await store.revokeToken("tok-1", "u1", exp());
    expect(await store.claimToken("tok-1", "u1", exp())).toBe(false);
  });

  it("a non-unique-violation error propagates rather than reading as a lost claim", async () => {
    vi.spyOn(prisma.revokedRefreshToken, "create").mockRejectedValueOnce(new Error("db down"));
    await expect(store.claimToken("tok-1", "u1", exp())).rejects.toThrow("db down");
  });
});

describe("PrismaRevocationStore — revoke-all via per-user cutoff", () => {
  it("rejects tokens issued at/before the cutoff", async () => {
    const before = Math.floor((Date.now() - 10_000) / 1000);
    await store.revokeAllForUser("u1");
    expect(await store.isRevoked("any", "u1", before)).toBe(true);
  });

  it("accepts a token issued strictly after the cutoff", async () => {
    await store.revokeAllForUser("u1");
    const after = Math.floor((Date.now() + 10_000) / 1000);
    expect(await store.isRevoked("any", "u1", after)).toBe(false);
  });

  it("does not affect other users", async () => {
    const ts = Math.floor((Date.now() - 1000) / 1000);
    await store.revokeAllForUser("u1");
    expect(await store.isRevoked("a", "u2", ts)).toBe(false);
  });

  it("isUserRevoked reflects the cutoff marker", async () => {
    expect(await store.isUserRevoked("u1")).toBe(false);
    await store.revokeAllForUser("u1");
    expect(await store.isUserRevoked("u1")).toBe(true);
  });

  it("clearUserRevocation removes the cutoff", async () => {
    await store.revokeAllForUser("u1");
    await store.clearUserRevocation("u1");
    expect(await store.isUserRevoked("u1")).toBe(false);
  });

  it("clearUserRevocation on a non-existent marker is a no-op (swallows not-found)", async () => {
    await expect(store.clearUserRevocation("never-seen")).resolves.toBeUndefined();
  });

  it("isCutOff (#582) applies the cutoff alone, ignoring per-token revocation", async () => {
    const before = Math.floor((Date.now() - 10_000) / 1000);
    const after = Math.floor((Date.now() + 10_000) / 1000);
    expect(await store.isCutOff("u1", before)).toBe(false);
    await store.revokeAllForUser("u1");
    expect(await store.isCutOff("u1", before)).toBe(true);
    expect(await store.isCutOff("u1", after)).toBe(false);
    expect(await store.isCutOff("u2", before)).toBe(false);
  });

  it("isCutOff fails closed when the cutoff read throws", async () => {
    vi.spyOn(prisma.userSessionRevocation, "findUnique").mockRejectedValueOnce(
      new Error("db down"),
    );
    expect(await store.isCutOff("u1", 123)).toBe(true);
  });

  it("skips the cutoff check when issuedAt is undefined", async () => {
    await store.revokeAllForUser("u1");
    // No iat passed → cutoff not consulted, and the tokenId itself isn't revoked.
    expect(await store.isRevoked("some-token", "u1")).toBe(false);
  });
});

describe("PrismaRevocationStore — fail closed (OWASP)", () => {
  it("treats the token as revoked when the store read throws", async () => {
    vi.spyOn(prisma.revokedRefreshToken, "findUnique").mockRejectedValueOnce(new Error("db down"));
    expect(await store.isRevoked("tok-1", "u1", 123)).toBe(true);
  });
});

describe("PrismaRevocationStore — pruning", () => {
  it("deletes only expired rows and returns the count", async () => {
    await store.revokeToken("expired-1", "u1", new Date(Date.now() - 1000));
    await store.revokeToken("expired-2", "u1", new Date(Date.now() - 9000));
    await store.revokeToken("live-1", "u1", new Date(Date.now() + 60_000));

    const removed = await store.pruneExpired();
    expect(removed).toBe(2);
    expect(await store.isRevoked("live-1", "u1")).toBe(true);
    expect(await store.isRevoked("expired-1", "u1")).toBe(false);
  });
});

describe("startRevocationPruner", () => {
  it("invokes pruneExpired on the configured interval and stops cleanly", async () => {
    vi.useFakeTimers();
    const fake: RevocationStore = {
      revokeToken: vi.fn(),
      claimToken: vi.fn(),
      isRevoked: vi.fn(),
      isCutOff: vi.fn(),
      revokeAllForUser: vi.fn(),
      clearUserRevocation: vi.fn(),
      isUserRevoked: vi.fn(),
      pruneExpired: vi.fn().mockResolvedValue(0),
    };
    const handle = startRevocationPruner(1000, fake);
    await vi.advanceTimersByTimeAsync(2500);
    expect(fake.pruneExpired).toHaveBeenCalledTimes(2);
    handle.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.pruneExpired).toHaveBeenCalledTimes(2);
  });

  it("logs and survives a prune run that rejects", async () => {
    vi.useFakeTimers();
    const fake: RevocationStore = {
      revokeToken: vi.fn(),
      claimToken: vi.fn(),
      isRevoked: vi.fn(),
      isCutOff: vi.fn(),
      revokeAllForUser: vi.fn(),
      clearUserRevocation: vi.fn(),
      isUserRevoked: vi.fn(),
      pruneExpired: vi.fn().mockRejectedValue(new Error("prune boom")),
    };
    const handle = startRevocationPruner(1000, fake);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.pruneExpired).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
