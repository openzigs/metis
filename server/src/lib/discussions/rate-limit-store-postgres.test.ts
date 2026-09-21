/**
 * Epic #518 (#541) — Postgres-backed shared rate-limit store tests.
 *
 * The whole point of #541 is that the AI-invocation cap holds *cluster-wide*
 * under N>1 replicas — not Nx. These tests prove that with a fake Prisma client
 * that models ONE shared Postgres: a single row store, an atomic `INSERT … ON
 * CONFLICT … DO UPDATE` upsert serialized exactly as Postgres row-locking would
 * serialize concurrent replicas. Two separately-constructed `PostgresRateLimitStore`
 * instances (= two replicas) share that one fake DB, and concurrent hits prove
 * the cap is global.
 *
 * (The end-to-end proof against a real `postgres:16-alpine` lives in the gated
 * rate-limit-store-postgres.integration.test.ts.)
 */
import { describe, expect, it } from "vitest";

import {
  PostgresRateLimitStore,
  registerPostgresRateLimitStore,
} from "./rate-limit-store-postgres.js";
import { __setPostgresStoreFactory, resolveRateLimitStore } from "./rate-limit-store.js";

/** A row in the fake `discussion_rate_limit_window` table. */
interface Row {
  bucket_key: string;
  window_start: number;
  window_end: number;
  count: number;
}

/**
 * Minimal fake of the Prisma client surface the Postgres store uses. It models a
 * SINGLE shared table and serializes upserts through a promise chain so that
 * concurrent `hit()` calls from two store instances interleave the way Postgres
 * row-locking serializes concurrent replicas — i.e. no lost increments.
 */
class FakeSharedPg {
  rows = new Map<string, Row>(); // key = `${bucket_key}|${window_start}`
  ddlCount = 0;
  // Serialization gate: every mutating query awaits the previous one.
  private tail: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(
      () =>
        // Yield to the event loop so concurrent callers genuinely interleave,
        // then apply the mutation atomically (single-threaded JS guarantees the
        // body runs without interruption — the analogue of a row lock).
        new Promise<T>((resolve) => setImmediate(() => resolve(fn()))),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  $executeRawUnsafe(sql: string): Promise<number> {
    if (sql.includes("CREATE UNLOGGED TABLE")) {
      this.ddlCount += 1;
      return Promise.resolve(0);
    }
    if (sql.includes("TRUNCATE")) {
      this.rows.clear();
      return Promise.resolve(0);
    }
    return Promise.resolve(0);
  }

  // Tagged-template `$queryRaw` — Prisma passes (strings, ...values). The store
  // only issues the upsert here; we read the interpolated values positionally.
  $queryRaw<T>(_strings: TemplateStringsArray, ...values: unknown[]): Promise<T> {
    const [key, windowStart, windowEnd] = values as [string, number, number];
    return this.serialize(() => {
      const id = `${key}|${windowStart}`;
      const existing = this.rows.get(id);
      if (existing) {
        existing.count += 1;
        return [{ count: existing.count }] as unknown as T;
      }
      this.rows.set(id, {
        bucket_key: key,
        window_start: windowStart,
        window_end: windowEnd,
        count: 1,
      });
      return [{ count: 1 }] as unknown as T;
    });
  }

  // Tagged-template `$executeRaw` — only the opportunistic prune lands here.
  $executeRaw(_strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const [now] = values as [number];
    return this.serialize(() => {
      for (const [id, row] of this.rows) {
        if (row.window_end <= now) this.rows.delete(id);
      }
      return 0;
    });
  }
}

function makeStore(db: FakeSharedPg): PostgresRateLimitStore {
  // The store accepts any object structurally matching the PrismaClient surface
  // it uses; the fake satisfies the three raw-query methods.
  return new PostgresRateLimitStore(db as unknown as never);
}

describe("PostgresRateLimitStore — atomic fixed-window counter", () => {
  it("allows up to max within a window, then denies", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    const now = 1_000_000;
    expect((await store.hit("k", 3, 1000, now)).allowed).toBe(true);
    expect((await store.hit("k", 3, 1000, now)).allowed).toBe(true);
    const third = await store.hit("k", 3, 1000, now);
    expect(third).toMatchObject({ allowed: true, recentCount: 3 });
    const denied = await store.hit("k", 3, 1000, now);
    expect(denied.allowed).toBe(false);
    expect(denied.recentCount).toBe(4); // saturating counter
    expect(denied.oldestTs).toBe(1_000_000); // window start, for retry math
  });

  it("creates the UNLOGGED table exactly once (memoised DDL)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.hit("k", 5, 1000, 1000);
    await store.hit("k", 5, 1000, 1000);
    await store.hit("k2", 5, 1000, 1000);
    expect(db.ddlCount).toBe(1);
  });

  it("rolls to a fresh window when the bucket advances (tumbling window)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    const windowMs = 1000;
    // Window 0: [0,1000)
    expect((await store.hit("k", 1, windowMs, 100)).allowed).toBe(true);
    expect((await store.hit("k", 1, windowMs, 900)).allowed).toBe(false);
    // Window 1: [1000,2000) — fresh counter, allowed again.
    expect((await store.hit("k", 1, windowMs, 1500)).allowed).toBe(true);
  });

  it("keys are independent", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    expect((await store.hit("a", 1, 1000, 0)).allowed).toBe(true);
    expect((await store.hit("a", 1, 1000, 0)).allowed).toBe(false);
    expect((await store.hit("b", 1, 1000, 0)).allowed).toBe(true);
  });

  it("reset() truncates the shared table", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    await store.hit("k", 1, 1000, 0);
    expect((await store.hit("k", 1, 1000, 0)).allowed).toBe(false);
    await store.reset();
    expect((await store.hit("k", 1, 1000, 0)).allowed).toBe(true);
  });

  it("prunes elapsed windows opportunistically (count stays bounded)", async () => {
    const db = new FakeSharedPg();
    const store = makeStore(db);
    // Force the prune path deterministically.
    const realRandom = Math.random;
    Math.random = () => 0; // always < PRUNE_PROBABILITY
    try {
      await store.hit("k", 5, 1000, 100); // window [0,1000)
      // A hit well after the first window's end triggers a prune of the elapsed row.
      await store.hit("k2", 5, 1000, 5000); // window [5000,6000)
      // Give the fire-and-forget prune a tick to run.
      await new Promise((r) => setImmediate(r));
      // The elapsed [0,1000) row should be gone; only the live one remains.
      expect([...db.rows.values()].some((r) => r.window_start === 0)).toBe(false);
    } finally {
      Math.random = realRandom;
    }
  });

  describe("CLUSTER-WIDE proof: 2 replicas share ONE Postgres", () => {
    it("the cap holds globally (NOT Nx) when two replicas hit concurrently", async () => {
      const sharedDb = new FakeSharedPg();
      // Two SEPARATELY-CONSTRUCTED store instances = two replicas/pods, each
      // with its OWN store object but pointed at the SAME shared Postgres.
      const replicaA = makeStore(sharedDb);
      const replicaB = makeStore(sharedDb);

      const max = 5;
      const windowMs = 60_000;
      const now = 1_000_000;
      const key = "thread::user"; // same (thread,user) across both replicas

      // Fire 20 hits concurrently, split across the two replicas — exactly the
      // race a load balancer creates under HPA.
      const calls: Array<Promise<{ allowed: boolean }>> = [];
      for (let i = 0; i < 10; i++) {
        calls.push(replicaA.hit(key, max, windowMs, now));
        calls.push(replicaB.hit(key, max, windowMs, now));
      }
      const results = await Promise.all(calls);
      const allowed = results.filter((r) => r.allowed).length;

      // The whole point of #541: cluster-wide cap. Without a shared atomic
      // store each replica would allow up to `max` (=> 2*max=10). With the
      // shared Postgres counter, EXACTLY `max` are allowed across BOTH replicas.
      expect(allowed).toBe(max);
      expect(results.length - allowed).toBe(20 - max); // the rest denied
    });

    it("a second window after expiry restores the GLOBAL budget across replicas", async () => {
      const sharedDb = new FakeSharedPg();
      const replicaA = makeStore(sharedDb);
      const replicaB = makeStore(sharedDb);
      const max = 2;
      const windowMs = 1000;
      const key = "t::u";

      // Window 0 saturates across replicas.
      expect((await replicaA.hit(key, max, windowMs, 100)).allowed).toBe(true);
      expect((await replicaB.hit(key, max, windowMs, 200)).allowed).toBe(true);
      expect((await replicaA.hit(key, max, windowMs, 300)).allowed).toBe(false);
      // Window 1 (>= 1000) — budget restored globally; either replica may hit.
      expect((await replicaB.hit(key, max, windowMs, 1500)).allowed).toBe(true);
      expect((await replicaA.hit(key, max, windowMs, 1600)).allowed).toBe(true);
      expect((await replicaB.hit(key, max, windowMs, 1700)).allowed).toBe(false);
    });
  });
});

describe("registerPostgresRateLimitStore", () => {
  it("wires the resolver so backend=postgres builds a PostgresRateLimitStore", () => {
    const db = new FakeSharedPg();
    registerPostgresRateLimitStore(db as unknown as never);
    const store = resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "postgres" });
    expect(store).toBeInstanceOf(PostgresRateLimitStore);
    // Clean up the global factory so other suites are unaffected.
    __setPostgresStoreFactory(() => {
      throw new Error("not registered");
    });
  });
});
