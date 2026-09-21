/**
 * Issue #520 (epic #517) — end-to-end proof that the Postgres-backed SAML
 * request-id cache gives cross-replica InResponseTo / replay protection against a
 * REAL Postgres, using two separately-constructed cache instances (= two pods)
 * sharing one database.
 *
 *   "A request id saved via one cache instance is visible to a SEPARATE instance
 *    sharing the backend (cross-replica), is single-use (remove makes a replay
 *    get miss), and expires past its TTL."
 *
 * Gated exactly like sso-state-store-postgres.integration.test.ts: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (via
 * `pnpm test:integration`). In CI a pgvector/postgres service is provided.
 * Locally it is skipped unless those conditions hold, so the default `pnpm test`
 * never needs a live database. The cache self-creates its UNLOGGED table behind
 * an advisory lock (no migration), so no schema setup beyond a reachable Postgres
 * is required.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { PostgresSamlRequestIdCache } from "../src/lib/auth/saml-request-id-cache-postgres.js";
import { selectPrismaAdapter } from "../src/lib/prisma.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

describe.runIf(enabled)(
  "PostgresSamlRequestIdCache cross-replica + single-use (integration)",
  () => {
    const adapter = selectPrismaAdapter(databaseUrl);
    const prisma = new PrismaClient({ adapter });

    // Two SEPARATELY-CONSTRUCTED caches sharing ONE Postgres = two replicas/pods.
    // A small fixed TTL so the expiry test is fast; an injectable clock keeps it
    // deterministic.
    let clock = Date.now();
    const now = () => clock;
    const replicaA = new PostgresSamlRequestIdCache(prisma, 60_000, now);
    const replicaB = new PostgresSamlRequestIdCache(prisma, 60_000, now);

    beforeEach(async () => {
      clock = Date.now();
      await replicaA.reset();
    });

    afterAll(async () => {
      await replicaA.reset();
      await prisma.$disconnect();
    });

    it("an id saved on replica A is visible to replica B (cross-replica continuity)", async () => {
      const id = `it::${Date.now()}`;
      await replicaA.saveAsync(id, "instant-1");
      expect(await replicaB.getAsync(id)).toBe("instant-1");
    });

    it("single-use: once replica B removes the id, replica A's get misses (replay rejected)", async () => {
      const id = `it-once::${Date.now()}`;
      await replicaA.saveAsync(id, "instant-1");
      expect(await replicaB.getAsync(id)).toBe("instant-1");
      expect(await replicaB.removeAsync(id)).toBe(id);
      // Replay hits a different pod — the id is gone cluster-wide.
      expect(await replicaA.getAsync(id)).toBeNull();
    });

    it("saveAsync returns null for a still-live duplicate id (no overwrite)", async () => {
      const id = `it-dup::${Date.now()}`;
      expect(await replicaA.saveAsync(id, "first")).not.toBeNull();
      expect(await replicaB.saveAsync(id, "second")).toBeNull();
      expect(await replicaA.getAsync(id)).toBe("first");
    });

    it("rejects an id past its TTL", async () => {
      const id = `it-ttl::${Date.now()}`;
      await replicaA.saveAsync(id, "instant-1"); // created at `clock`
      clock += 60_000; // created_at + ttl <= now
      expect(await replicaB.getAsync(id)).toBeNull();
    });
  },
);
