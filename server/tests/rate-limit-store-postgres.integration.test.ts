/**
 * Issue #541 (epic #518) — end-to-end proof that the Postgres-backed rate-limit
 * store enforces the discussion AI-invocation cap *cluster-wide* against a REAL
 * Postgres, using a genuine concurrent two-replica race (not a fake).
 *
 *   "Prove cluster-wide enforcement: 2+ workers against one store stay within the
 *    cap (not Nx)."
 *
 * Gated exactly like prisma-postgres-connection.integration.test.ts: runs only
 * when `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (via
 * `pnpm test:integration`). In CI a `postgres:16-alpine` service is provided.
 * Locally it is skipped unless those conditions hold, so the default `pnpm test`
 * never needs a live database. The store self-creates its UNLOGGED counter table
 * (no migration), so no schema setup beyond a reachable Postgres is required.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { selectPrismaAdapter } from "../src/lib/prisma.js";
import { PostgresRateLimitStore } from "../src/lib/discussions/rate-limit-store-postgres.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

describe.runIf(enabled)("PostgresRateLimitStore cluster-wide enforcement (integration)", () => {
  const adapter = selectPrismaAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  // Two SEPARATELY-CONSTRUCTED stores sharing ONE Postgres = two replicas/pods.
  const replicaA = new PostgresRateLimitStore(prisma);
  const replicaB = new PostgresRateLimitStore(prisma);

  beforeEach(async () => {
    await replicaA.reset();
  });

  afterAll(async () => {
    await replicaA.reset();
    await prisma.$disconnect();
  });

  it("holds the cap GLOBALLY (not Nx) under a real concurrent two-replica race", async () => {
    const max = 5;
    const windowMs = 60_000;
    const now = Date.now();
    const key = `it::${now}`; // unique per run so reruns never collide

    // 20 hits fired concurrently, split across two replicas — the HPA race.
    const calls: Array<Promise<{ allowed: boolean }>> = [];
    for (let i = 0; i < 10; i++) {
      calls.push(replicaA.hit(key, max, windowMs, now));
      calls.push(replicaB.hit(key, max, windowMs, now));
    }
    const results = await Promise.all(calls);
    const allowed = results.filter((r) => r.allowed).length;

    // Postgres row-locking serializes the upsert across replicas → exactly the
    // cap is allowed cluster-wide, NOT 2*max.
    expect(allowed).toBe(max);
  });

  it("restores the global budget in the next fixed window", async () => {
    const max = 2;
    const windowMs = 1000;
    const base = Date.now();
    const key = `it-window::${base}`;
    const w0 = Math.floor(base / windowMs) * windowMs; // window 0 start

    expect((await replicaA.hit(key, max, windowMs, w0)).allowed).toBe(true);
    expect((await replicaB.hit(key, max, windowMs, w0 + 100)).allowed).toBe(true);
    expect((await replicaA.hit(key, max, windowMs, w0 + 200)).allowed).toBe(false);
    // Next window — fresh global budget.
    expect((await replicaB.hit(key, max, windowMs, w0 + windowMs + 10)).allowed).toBe(true);
  });
});
