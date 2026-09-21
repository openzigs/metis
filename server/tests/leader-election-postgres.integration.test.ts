/**
 * Issue #544 (epic #518) — end-to-end proof that the Postgres-backed
 * leader-election lease + per-fire window claim give EXACTLY-ONCE cluster-wide
 * scheduling and CRASH FAILOVER against a REAL Postgres, using separately-
 * constructed elector/backend instances (= separate pods) sharing one database.
 *
 * Gated exactly like rate-limit-store-postgres / sso-state-store-postgres: runs
 * only when `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (via
 * `pnpm test:integration`). In CI the `postgres-adapter` job provides a real
 * Postgres. Locally it is skipped unless those conditions hold, so the default
 * `pnpm test` never needs a live database. The backend self-creates its UNLOGGED
 * tables behind an advisory lock (no migration), so no schema setup beyond a
 * reachable Postgres is required.
 */
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { selectPrismaAdapter } from "../src/lib/prisma.js";
import {
  LeaderElector,
  PostgresLeaseBackend,
  withJobWindowLock,
} from "../src/lib/scheduler/leader-election.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

describe.runIf(enabled)("Postgres leader election: exactly-once + failover (integration)", () => {
  const adapter = selectPrismaAdapter(databaseUrl);
  const prisma = new PrismaClient({ adapter });

  // Separately-constructed backends sharing ONE Postgres = separate pods.
  const backendA = new PostgresLeaseBackend(prisma);
  const backendB = new PostgresLeaseBackend(prisma);
  const backendC = new PostgresLeaseBackend(prisma);

  beforeEach(async () => {
    await backendA.reset();
  });

  afterAll(async () => {
    await backendA.reset();
    await prisma.$disconnect();
  });

  it("only ONE of three contending replicas wins leadership for a lease", async () => {
    const lockName = `it-leader::${Date.now()}`;
    const now = () => Date.now();
    const a = new LeaderElector({
      backend: backendA,
      lockName,
      holderId: "pod-a",
      now,
      autoRenew: false,
    });
    const b = new LeaderElector({
      backend: backendB,
      lockName,
      holderId: "pod-b",
      now,
      autoRenew: false,
    });
    const c = new LeaderElector({
      backend: backendC,
      lockName,
      holderId: "pod-c",
      now,
      autoRenew: false,
    });

    await Promise.all([a.start(), b.start(), c.start()]);

    const leaders = [a, b, c].filter((e) => e.isLeader());
    expect(leaders).toHaveLength(1);
  });

  it("a survivor acquires leadership after the dead leader's lease TTL expires", async () => {
    const lockName = `it-failover::${Date.now()}`;
    const t0 = Date.now();
    const leaseTtlMs = 1_000;

    // Injected logical clock so the test is deterministic without sleeping.
    let clock = t0;
    const now = () => clock;

    const a = new LeaderElector({
      backend: backendA,
      lockName,
      holderId: "pod-a",
      now,
      leaseTtlMs,
      autoRenew: false,
    });
    const b = new LeaderElector({
      backend: backendB,
      lockName,
      holderId: "pod-b",
      now,
      leaseTtlMs,
      autoRenew: false,
    });

    await a.start();
    expect(a.isLeader()).toBe(true);

    // B cannot take over while A's lease is valid (same logical clock).
    await b.tryAcquire();
    expect(b.isLeader()).toBe(false);

    // A "crashes": it never renews. Probe B past the TTL — it must win.
    clock = t0 + leaseTtlMs + 500;
    await b.tryAcquire();
    expect(b.isLeader()).toBe(true);
  });

  it("exactly one replica runs a given job window; others skip (per-fire claim)", async () => {
    const jobName = `it-window::${Date.now()}`;
    const window = "2026-06-29T00:00";
    const now = () => Date.now();
    let runs = 0;
    const fn = async () => {
      runs += 1;
    };

    const results = await Promise.all([
      withJobWindowLock(jobName, fn, {
        backend: backendA,
        window,
        holderId: "pod-a",
        now,
        ttlMs: 5_000,
      }),
      withJobWindowLock(jobName, fn, {
        backend: backendB,
        window,
        holderId: "pod-b",
        now,
        ttlMs: 5_000,
      }),
      withJobWindowLock(jobName, fn, {
        backend: backendC,
        window,
        holderId: "pod-c",
        now,
        ttlMs: 5_000,
      }),
    ]);

    expect(runs).toBe(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
  });
});
