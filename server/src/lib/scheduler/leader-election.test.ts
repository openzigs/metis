/**
 * Issue #544 (Epic #518) — unit tests for the distributed leader-election /
 * job-window locking primitive that makes the in-process scheduler + background
 * jobs run EXACTLY ONCE cluster-wide instead of once per replica.
 *
 * These tests exercise the logic against a fully in-memory fake lease backend so
 * they are deterministic and need no Postgres (the REAL-Postgres proof lives in
 * leader-election-postgres.integration.test.ts, gated + wired into CI like
 * #541/#542). The fake faithfully models the two atomic primitives the Postgres
 * store implements:
 *   - acquireOrRenew(name, holder, now, ttlMs): the leader lease upsert that only
 *     grants/keeps leadership when the row is free, expired, or already ours.
 *   - claimWindow(name, window, now, ttlMs): the per-fire window claim that the
 *     FIRST caller wins and all others skip (INSERT … ON CONFLICT DO NOTHING).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LeaderElector,
  PostgresLeaseBackend,
  resolveLeaderElection,
  withJobWindowLock,
  type LeaseBackend,
  type ResolveLeaderElectionEnv,
} from "./leader-election.js";

/**
 * Deterministic in-memory lease backend shared by N electors to simulate N
 * replicas contending against ONE database. Models the atomicity of the real
 * Postgres statements: every operation is synchronous-then-resolved, so there is
 * no interleaving within a single call — exactly the serialization Postgres
 * gives via row locks.
 */
class FakeLeaseBackend implements LeaseBackend {
  leases = new Map<string, { holder: string; expiresAt: number }>();
  windows = new Map<string, { holder: string; expiresAt: number }>();
  /** Count of acquireOrRenew calls (to assert no thundering herd). */
  acquireCalls = 0;

  async acquireOrRenew(name: string, holder: string, now: number, ttlMs: number): Promise<boolean> {
    this.acquireCalls += 1;
    const cur = this.leases.get(name);
    const free = !cur || cur.expiresAt <= now || cur.holder === holder;
    if (!free) return false;
    this.leases.set(name, { holder, expiresAt: now + ttlMs });
    return true;
  }

  async release(name: string, holder: string): Promise<void> {
    const cur = this.leases.get(name);
    if (cur && cur.holder === holder) this.leases.delete(name);
  }

  async claimWindow(
    name: string,
    window: string,
    holder: string,
    now: number,
    ttlMs: number,
  ): Promise<boolean> {
    const key = `${name}::${window}`;
    const cur = this.windows.get(key);
    if (cur && cur.expiresAt > now) return false; // already claimed this window
    this.windows.set(key, { holder, expiresAt: now + ttlMs });
    return true;
  }

  async reset(): Promise<void> {
    this.leases.clear();
    this.windows.clear();
  }
}

describe("LeaderElector — single replica", () => {
  let backend: FakeLeaseBackend;

  beforeEach(() => {
    backend = new FakeLeaseBackend();
  });

  it("a lone replica acquires leadership immediately on start", async () => {
    const elector = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-a",
      now: () => 1_000,
      autoRenew: false,
    });
    expect(elector.isLeader()).toBe(false);
    await elector.start();
    expect(elector.isLeader()).toBe(true);
    await elector.stop();
  });

  it("releases the lease on stop so the row does not wedge scheduling", async () => {
    const elector = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-a",
      now: () => 1_000,
      autoRenew: false,
    });
    await elector.start();
    expect(backend.leases.has("scheduler")).toBe(true);
    await elector.stop();
    expect(backend.leases.has("scheduler")).toBe(false);
    expect(elector.isLeader()).toBe(false);
  });

  it("fires onChange(true) exactly once when leadership is first won", async () => {
    const onChange = vi.fn();
    const elector = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-a",
      now: () => 1_000,
      autoRenew: false,
      onChange,
    });
    await elector.start();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
    await elector.stop();
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe("LeaderElector — exactly-once across replicas", () => {
  let backend: FakeLeaseBackend;

  beforeEach(() => {
    backend = new FakeLeaseBackend();
  });

  it("only ONE of three contending replicas becomes leader", async () => {
    let clock = 5_000;
    const now = () => clock;
    const electors = ["pod-a", "pod-b", "pod-c"].map(
      (id) =>
        new LeaderElector({
          backend,
          lockName: "scheduler",
          holderId: id,
          now,
          autoRenew: false,
        }),
    );

    // All three start at the same instant against the SAME shared backend.
    await Promise.all(electors.map((e) => e.start()));

    const leaders = electors.filter((e) => e.isLeader());
    expect(leaders).toHaveLength(1);

    // Non-leaders, re-attempting before the TTL elapses, still lose.
    clock += 100;
    await Promise.all(electors.map((e) => e.tryAcquire()));
    expect(electors.filter((e) => e.isLeader())).toHaveLength(1);

    await Promise.all(electors.map((e) => e.stop()));
  });

  it("a held, unexpired lease blocks other replicas from acquiring", async () => {
    let clock = 0;
    const now = () => clock;
    const a = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-a",
      now,
      leaseTtlMs: 30_000,
      autoRenew: false,
    });
    const b = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-b",
      now,
      leaseTtlMs: 30_000,
      autoRenew: false,
    });
    await a.start();
    clock = 10_000; // still within A's 30s lease
    await b.tryAcquire();
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    await a.stop();
    await b.stop();
  });
});

describe("LeaderElector — failover on leader crash / lease expiry", () => {
  let backend: FakeLeaseBackend;

  beforeEach(() => {
    backend = new FakeLeaseBackend();
  });

  it("a survivor acquires leadership after the dead leader's lease expires", async () => {
    let clock = 0;
    const now = () => clock;
    const a = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-a",
      now,
      leaseTtlMs: 30_000,
      autoRenew: false,
    });
    const b = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-b",
      now,
      leaseTtlMs: 30_000,
      autoRenew: false,
    });

    await a.start();
    expect(a.isLeader()).toBe(true);

    // Pod A "crashes" — it never releases (no stop()), and stops renewing.
    // Pod B keeps probing. Before the TTL it cannot take over...
    clock = 20_000;
    await b.tryAcquire();
    expect(b.isLeader()).toBe(false);

    // ...but once A's lease has fully expired (TTL elapsed), B wins.
    clock = 31_000;
    await b.tryAcquire();
    expect(b.isLeader()).toBe(true);
  });

  it("a stale local 'leader' flag is dropped when the lease is lost to another holder", async () => {
    let clock = 0;
    const now = () => clock;
    const a = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-a",
      now,
      leaseTtlMs: 10_000,
      autoRenew: false,
    });
    const b = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-b",
      now,
      leaseTtlMs: 10_000,
      autoRenew: false,
    });
    await a.start();
    expect(a.isLeader()).toBe(true);

    // A pauses (GC / network blip) past its TTL; B steals the lease.
    clock = 11_000;
    await b.tryAcquire();
    expect(b.isLeader()).toBe(true);

    // A wakes and re-probes: it must NOT believe it is still leader.
    clock = 12_000;
    await a.tryAcquire();
    expect(a.isLeader()).toBe(false);
    await b.stop();
  });

  it("onChange fires false when leadership is lost, true when re-won", async () => {
    let clock = 0;
    const now = () => clock;
    const onChange = vi.fn();
    const a = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-a",
      now,
      leaseTtlMs: 10_000,
      autoRenew: false,
      onChange,
    });
    const b = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-b",
      now,
      leaseTtlMs: 10_000,
      autoRenew: false,
    });
    await a.start();
    expect(onChange).toHaveBeenLastCalledWith(true);

    clock = 11_000;
    await b.tryAcquire(); // B steals
    await a.tryAcquire(); // A notices loss
    expect(onChange).toHaveBeenLastCalledWith(false);

    // B stops; A re-wins.
    await b.stop();
    clock = 12_000;
    await a.tryAcquire();
    expect(onChange).toHaveBeenLastCalledWith(true);
    await a.stop();
  });
});

describe("LeaderElector — auto-renew timer lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renews the lease on the renew interval and keeps leadership", async () => {
    const backend = new FakeLeaseBackend();
    let clock = 0;
    const elector = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-a",
      now: () => clock,
      leaseTtlMs: 30_000,
      renewIntervalMs: 10_000,
      autoRenew: true,
    });
    await elector.start();
    expect(elector.isLeader()).toBe(true);
    const callsAfterStart = backend.acquireCalls;

    // Advance two renew intervals; the renew timer must fire and re-acquire.
    clock = 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    clock = 20_000;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(backend.acquireCalls).toBeGreaterThan(callsAfterStart);
    expect(elector.isLeader()).toBe(true);
    await elector.stop();
  });

  it("a non-leader keeps probing on the renew interval and takes over on expiry", async () => {
    const backend = new FakeLeaseBackend();
    let clock = 0;
    const now = () => clock;
    // Pre-seed an expiring lease held by a 'dead' pod.
    backend.leases.set("scheduler", { holder: "dead-pod", expiresAt: 15_000 });

    const b = new LeaderElector({
      backend,
      lockName: "scheduler",
      holderId: "pod-b",
      now,
      leaseTtlMs: 30_000,
      renewIntervalMs: 10_000,
      autoRenew: true,
    });
    await b.start();
    expect(b.isLeader()).toBe(false); // dead-pod's lease still valid at t=0

    clock = 20_000; // dead-pod lease expired
    await vi.advanceTimersByTimeAsync(10_000);
    expect(b.isLeader()).toBe(true);
    await b.stop();
  });
});

describe("withJobWindowLock — per-fire single execution", () => {
  let backend: FakeLeaseBackend;

  beforeEach(() => {
    backend = new FakeLeaseBackend();
  });

  it("runs the job for the FIRST caller and skips all concurrent contenders", async () => {
    const runs: string[] = [];
    const makeFn = (id: string) => async () => {
      runs.push(id);
    };
    const opts = { backend, window: "2026-06-29T00:00", now: () => 1_000, ttlMs: 60_000 };

    const results = await Promise.all([
      withJobWindowLock("chargeback", makeFn("a"), { ...opts, holderId: "pod-a" }),
      withJobWindowLock("chargeback", makeFn("b"), { ...opts, holderId: "pod-b" }),
      withJobWindowLock("chargeback", makeFn("c"), { ...opts, holderId: "pod-c" }),
    ]);

    // Exactly one ran.
    expect(runs).toHaveLength(1);
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(results.filter((r) => !r.ran)).toHaveLength(2);
  });

  it("different windows each get exactly one run (next tick fires again)", async () => {
    const runs: string[] = [];
    const fn = async () => {
      runs.push("x");
    };
    await withJobWindowLock("sla", fn, {
      backend,
      window: "w1",
      holderId: "pod-a",
      now: () => 1_000,
      ttlMs: 1_000,
    });
    await withJobWindowLock("sla", fn, {
      backend,
      window: "w2",
      holderId: "pod-a",
      now: () => 1_000,
      ttlMs: 1_000,
    });
    expect(runs).toHaveLength(2);
  });

  it("propagates the job's return value to the winner and marks ran=true", async () => {
    const res = await withJobWindowLock("forecast", async () => 42, {
      backend,
      window: "w1",
      holderId: "pod-a",
      now: () => 1_000,
      ttlMs: 1_000,
    });
    expect(res).toEqual({ ran: true, value: 42 });
  });

  it("a thrown job error releases nothing the loser needs and still surfaces", async () => {
    await expect(
      withJobWindowLock(
        "forecast",
        async () => {
          throw new Error("boom");
        },
        { backend, window: "w1", holderId: "pod-a", now: () => 1_000, ttlMs: 1_000 },
      ),
    ).rejects.toThrow("boom");
  });
});

describe("resolveLeaderElection — env gating + dev default", () => {
  const baseBackend = new FakeLeaseBackend();

  function resolve(env: ResolveLeaderElectionEnv) {
    return resolveLeaderElection({ ...env, backendFactory: () => baseBackend });
  }

  it("returns an always-leader elector when election is disabled (default)", async () => {
    const elector = resolve({});
    await elector.start();
    // Lone-replica / dev default: always the leader, no backend needed.
    expect(elector.isLeader()).toBe(true);
    await elector.stop();
    expect(elector.isLeader()).toBe(true); // always-leader never drops
  });

  it("returns an always-leader elector when DATABASE_URL is SQLite even if enabled", async () => {
    const elector = resolve({
      SCHEDULER_LEADER_ELECTION: "postgres",
      DATABASE_URL: "file:./dev.db",
    });
    await elector.start();
    expect(elector.isLeader()).toBe(true);
    await elector.stop();
  });

  it("returns a real Postgres-backed elector when enabled AND DATABASE_URL is Postgres", async () => {
    const elector = resolve({
      SCHEDULER_LEADER_ELECTION: "postgres",
      DATABASE_URL: "postgresql://u:p@h/db",
    });
    // Uses the lease backend → contends for the lease (here our fake grants it).
    await elector.start();
    expect(elector.isLeader()).toBe(true);
    await elector.stop();
  });

  it("treats unknown SCHEDULER_LEADER_ELECTION values as disabled (fail-safe single-process)", async () => {
    const elector = resolve({ SCHEDULER_LEADER_ELECTION: "redis" });
    await elector.start();
    expect(elector.isLeader()).toBe(true);
    await elector.stop();
  });

  it("always-leader tryAcquire always returns true and exposes a holder id", async () => {
    const elector = resolve({});
    expect(await elector.tryAcquire()).toBe(true);
    expect(typeof elector.id()).toBe("string");
  });
});

describe("LeaderElector — backend errors must not promote / must demote", () => {
  it("a probe failure keeps a follower a follower (no split-brain)", async () => {
    const backend: LeaseBackend = {
      acquireOrRenew: vi.fn().mockRejectedValue(new Error("conn reset")),
      release: vi.fn().mockResolvedValue(undefined),
      claimWindow: vi.fn().mockResolvedValue(false),
      reset: vi.fn().mockResolvedValue(undefined),
    };
    const elector = new LeaderElector({ backend, holderId: "pod-a", autoRenew: false });
    const won = await elector.tryAcquire();
    expect(won).toBe(false);
    expect(elector.isLeader()).toBe(false);
  });

  it("a probe failure demotes a previously-elected leader (lease no longer provable)", async () => {
    const acquire = vi
      .fn()
      .mockResolvedValueOnce(true) // start: wins
      .mockRejectedValueOnce(new Error("conn reset")); // renew: backend down
    const backend: LeaseBackend = {
      acquireOrRenew: acquire,
      release: vi.fn().mockResolvedValue(undefined),
      claimWindow: vi.fn(),
      reset: vi.fn(),
    };
    const elector = new LeaderElector({ backend, holderId: "pod-a", autoRenew: false });
    await elector.start();
    expect(elector.isLeader()).toBe(true);
    await elector.tryAcquire();
    expect(elector.isLeader()).toBe(false);
  });

  it("a release failure on stop is swallowed (lease will expire via TTL)", async () => {
    const backend: LeaseBackend = {
      acquireOrRenew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockRejectedValue(new Error("conn reset")),
      claimWindow: vi.fn(),
      reset: vi.fn(),
    };
    const elector = new LeaderElector({ backend, holderId: "pod-a", autoRenew: false });
    await elector.start();
    await expect(elector.stop()).resolves.toBeUndefined();
    expect(elector.isLeader()).toBe(false);
  });

  it("an onChange handler that throws does not break the elector", async () => {
    const backend: LeaseBackend = {
      acquireOrRenew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      claimWindow: vi.fn(),
      reset: vi.fn(),
    };
    const elector = new LeaderElector({
      backend,
      holderId: "pod-a",
      autoRenew: false,
      onChange: () => {
        throw new Error("handler boom");
      },
    });
    await expect(elector.start()).resolves.toBeUndefined();
    expect(elector.isLeader()).toBe(true);
    await elector.stop();
  });

  it("tryAcquire after stop is a no-op (returns false without touching the backend)", async () => {
    const backend: LeaseBackend = {
      acquireOrRenew: vi.fn().mockResolvedValue(true),
      release: vi.fn().mockResolvedValue(undefined),
      claimWindow: vi.fn(),
      reset: vi.fn(),
    };
    const elector = new LeaderElector({ backend, holderId: "pod-a", autoRenew: false });
    await elector.stop();
    expect(await elector.tryAcquire()).toBe(false);
  });
});

/**
 * A minimal fake PrismaClient exposing only the raw-query methods the
 * PostgresLeaseBackend uses. Lets us unit-test the backend's return-value logic
 * and bootstrap/retry/prune branches without a live database (the REAL Postgres
 * proof is the gated integration test).
 */
function fakePrisma(over: Partial<Record<string, unknown>> = {}) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(0),
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn().mockResolvedValue([]),
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("PostgresLeaseBackend — SQL result handling (mocked prisma)", () => {
  it("acquireOrRenew returns true only when our holder row comes back", async () => {
    const db = fakePrisma({ $queryRaw: vi.fn().mockResolvedValue([{ holder: "pod-a" }]) });
    const backend = new PostgresLeaseBackend(db);
    expect(await backend.acquireOrRenew("scheduler", "pod-a", 1000, 30000)).toBe(true);
    // bootstrap DDL ran once.
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("acquireOrRenew returns false when another holder owns the row", async () => {
    const db = fakePrisma({ $queryRaw: vi.fn().mockResolvedValue([{ holder: "pod-b" }]) });
    const backend = new PostgresLeaseBackend(db);
    expect(await backend.acquireOrRenew("scheduler", "pod-a", 1000, 30000)).toBe(false);
  });

  it("acquireOrRenew returns false when no row is returned (lease still foreign)", async () => {
    const db = fakePrisma({ $queryRaw: vi.fn().mockResolvedValue([]) });
    const backend = new PostgresLeaseBackend(db);
    expect(await backend.acquireOrRenew("scheduler", "pod-a", 1000, 30000)).toBe(false);
  });

  it("memoises the table bootstrap across calls (one DDL per process)", async () => {
    const db = fakePrisma({ $queryRaw: vi.fn().mockResolvedValue([{ holder: "pod-a" }]) });
    const backend = new PostgresLeaseBackend(db);
    await backend.acquireOrRenew("scheduler", "pod-a", 1000, 30000);
    await backend.acquireOrRenew("scheduler", "pod-a", 2000, 30000);
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("a failed bootstrap is retried on the next call (memo reset)", async () => {
    const ddl = vi.fn().mockRejectedValueOnce(new Error("ddl fail")).mockResolvedValue(0);
    const db = fakePrisma({
      $executeRawUnsafe: ddl,
      $queryRaw: vi.fn().mockResolvedValue([{ holder: "pod-a" }]),
    });
    const backend = new PostgresLeaseBackend(db);
    await expect(backend.acquireOrRenew("scheduler", "pod-a", 1000, 30000)).rejects.toThrow(
      "ddl fail",
    );
    // Second call retries the DDL rather than reusing the rejected memo.
    expect(await backend.acquireOrRenew("scheduler", "pod-a", 2000, 30000)).toBe(true);
    expect(ddl).toHaveBeenCalledTimes(2);
  });

  it("release issues a holder-scoped delete", async () => {
    const db = fakePrisma();
    const backend = new PostgresLeaseBackend(db);
    await backend.release("scheduler", "pod-a");
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("claimWindow returns true for the winner row and runs the opportunistic prune", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(0); // force prune path
    const db = fakePrisma({ $queryRaw: vi.fn().mockResolvedValue([{ holder: "pod-a" }]) });
    const backend = new PostgresLeaseBackend(db);
    expect(await backend.claimWindow("chargeback", "w1", "pod-a", 1000, 5000)).toBe(true);
    expect(db.$executeRaw).toHaveBeenCalled(); // prune fired
    rnd.mockRestore();
  });

  it("claimWindow returns false when the row belongs to someone else (lost the window)", async () => {
    const rnd = vi.spyOn(Math, "random").mockReturnValue(1); // skip prune
    const db = fakePrisma({ $queryRaw: vi.fn().mockResolvedValue([]) });
    const backend = new PostgresLeaseBackend(db);
    expect(await backend.claimWindow("chargeback", "w1", "pod-a", 1000, 5000)).toBe(false);
    rnd.mockRestore();
  });

  it("reset truncates both tables best-effort", async () => {
    const db = fakePrisma();
    const backend = new PostgresLeaseBackend(db);
    await backend.reset();
    // 1 DDL bootstrap + 2 truncates.
    expect(db.$executeRawUnsafe).toHaveBeenCalledTimes(3);
  });
});
