/**
 * #582 — two concurrent refreshes with ONE refresh token, against a REAL SQLite
 * database built from the migration chain (no store or Prisma mock).
 *
 * `PrismaRevocationStore.claimToken` relies on the unique index on
 * `revoked_refresh_tokens.token_id` raising P2002 for the losing insert, and on
 * `isUniqueViolation` recognising what the driver adapter actually throws. The
 * mocked-Prisma unit tests cannot show either, so this file does:
 *   - the route: exactly one 200 and one 401, with BOTH requests reaching the
 *     claim (so the 401 came from the lost insert, not from the earlier check);
 *   - the store: a second claim of one token resolves `false` rather than
 *     rejecting — a rejection would mean the adapter's error is not recognised
 *     as a unique violation (the route would still 401, hiding it).
 */
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { getPermissionsForRole } from "@metis/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { authRouter } = await import("../src/routes/auth.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { revocationStore, PrismaRevocationStore } =
  await import("../src/lib/auth/revocation-store.js");

const USER = "u-582";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#582 — concurrent refresh with one token against real SQLite",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/auth", authRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };

    const freshRefreshToken = () =>
      issueTokens({
        userId: USER,
        username: USER,
        role: "developer",
        permissions: getPermissionsForRole("developer"),
      }).refreshToken;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("582-refresh-concurrent");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("POST /api/auth/refresh ×2 concurrently with one token — exactly one 200 and one 401", async () => {
      // Hold each claim until BOTH requests have passed verification and reached
      // it, then let both hit the real insert. In-process, supertest otherwise
      // tends to finish one request before the other verifies, and the loser is
      // refused by the pre-check — which is not the path under test. The inserts
      // themselves are real and unsynchronised; only their start is aligned.
      const realClaim = revocationStore.claimToken.bind(revocationStore);
      let arrive!: () => void;
      const bothArrived = new Promise<void>((resolve) => {
        let n = 0;
        arrive = () => {
          n += 1;
          if (n === 2) resolve();
        };
      });
      const claim = vi
        .spyOn(revocationStore, "claimToken")
        .mockImplementation(async (tokenId, userId, expiresAt) => {
          arrive();
          await bothArrived;
          return realClaim(tokenId, userId, expiresAt);
        });
      const refreshToken = freshRefreshToken();
      const [a, b] = await Promise.all([
        request(app()).post("/api/auth/refresh").send({ refreshToken }),
        request(app()).post("/api/auth/refresh").send({ refreshToken }),
      ]);
      const statuses = [a.status, b.status].sort();
      expect(statuses).toEqual([200, 401]);
      const loser = a.status === 401 ? a : b;
      expect(loser.body.error?.code ?? loser.body.code).toBe("REFRESH_FAILED");
      // Both requests passed verification and raced on the insert: the loser was
      // decided by the unique index, not by the pre-check.
      expect(claim).toHaveBeenCalledTimes(2);
      const outcomes = await Promise.all(claim.mock.results.map((r) => r.value));
      expect(outcomes.sort()).toEqual([false, true]);
      expect(await db.revokedRefreshToken.count()).toBeGreaterThanOrEqual(1);
    });

    it("the driver adapter's unique violation is recognised: a second claim resolves false", async () => {
      const store = new PrismaRevocationStore();
      const expiresAt = new Date(Date.now() + 60_000);
      expect(await store.claimToken("tok-582-direct", USER, expiresAt)).toBe(true);
      await expect(store.claimToken("tok-582-direct", USER, expiresAt)).resolves.toBe(false);
      expect(await db.revokedRefreshToken.count({ where: { tokenId: "tok-582-direct" } })).toBe(1);
    });
  },
);
