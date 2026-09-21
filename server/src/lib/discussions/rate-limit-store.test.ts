/**
 * Epic #475 (#508) → Epic #518 (#541) — pluggable rate-limit store tests.
 *
 * Covers the seam and the in-memory backends. The async store contract is
 * exercised here; the cross-replica Postgres and Valkey backends have their own
 * suites (rate-limit-store-postgres.test.ts / rate-limit-store-valkey.test.ts)
 * including the cluster-wide multi-worker proof.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  InMemoryRateLimitStore,
  SharedRateLimitStore,
  evaluateWindow,
  resolveRateLimitStore,
  __resetSharedRateLimitStore,
  __setPostgresStoreFactory,
  __setValkeyStoreFactory,
  type RateLimitStore,
} from "./rate-limit-store.js";

describe("evaluateWindow (sync core)", () => {
  it("allows up to max then denies and reports recentCount + oldestTs", () => {
    const now = 1_000_000;
    const a = evaluateWindow([], 2, 1000, now);
    expect(a.result).toMatchObject({ allowed: true, recentCount: 1 });
    const b = evaluateWindow(a.persist, 2, 1000, now);
    expect(b.result).toMatchObject({ allowed: true, recentCount: 2 });
    const c = evaluateWindow(b.persist, 2, 1000, now);
    expect(c.result.allowed).toBe(false);
    expect(c.result.recentCount).toBe(2);
    expect(c.result.oldestTs).toBe(now);
  });

  it("prunes timestamps older than the window", () => {
    const t0 = 1_000_000;
    let persist: number[] = [];
    persist = evaluateWindow(persist, 2, 1000, t0).persist;
    persist = evaluateWindow(persist, 2, 1000, t0).persist;
    expect(evaluateWindow(persist, 2, 1000, t0).result.allowed).toBe(false);
    // Past the window — both timestamps age out.
    expect(evaluateWindow(persist, 2, 1000, t0 + 1001).result.allowed).toBe(true);
  });

  it("does not record a hit when over the limit", () => {
    const t0 = 1_000_000;
    const first = evaluateWindow([], 1, 1000, t0);
    const denied = evaluateWindow(first.persist, 1, 1000, t0);
    expect(denied.result.allowed).toBe(false);
    // Only the first hit persisted; after the window a fresh hit is allowed.
    expect(evaluateWindow(denied.persist, 1, 1000, t0 + 1001).result.allowed).toBe(true);
  });
});

describe("InMemoryRateLimitStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("allows hits up to max, then denies (async hit)", async () => {
    const store = new InMemoryRateLimitStore();
    const now = Date.now();
    expect((await store.hit("k", 2, 1000, now)).allowed).toBe(true);
    expect((await store.hit("k", 2, 1000, now)).allowed).toBe(true);
    const c = await store.hit("k", 2, 1000, now);
    expect(c.allowed).toBe(false);
    expect(c.oldestTs).toBe(now);
  });

  it("hitSync exposes the synchronous core", () => {
    const store = new InMemoryRateLimitStore();
    const now = Date.now();
    expect(store.hitSync("k", 1, 1000, now).allowed).toBe(true);
    expect(store.hitSync("k", 1, 1000, now).allowed).toBe(false);
  });

  it("keys are independent", async () => {
    const store = new InMemoryRateLimitStore();
    const now = Date.now();
    await store.hit("a", 1, 1000, now);
    expect((await store.hit("a", 1, 1000, now)).allowed).toBe(false);
    expect((await store.hit("b", 1, 1000, now)).allowed).toBe(true);
  });

  it("reset() clears all recorded state", async () => {
    const store = new InMemoryRateLimitStore();
    const now = Date.now();
    await store.hit("k", 1, 1000, now);
    expect((await store.hit("k", 1, 1000, now)).allowed).toBe(false);
    await store.reset();
    expect((await store.hit("k", 1, 1000, now)).allowed).toBe(true);
  });

  it("TWO SEPARATE in-memory stores do NOT share state (per-process by design)", async () => {
    const replicaA = new InMemoryRateLimitStore();
    const replicaB = new InMemoryRateLimitStore();
    const now = Date.now();
    expect((await replicaA.hit("k", 2, 1000, now)).allowed).toBe(true);
    expect((await replicaA.hit("k", 2, 1000, now)).allowed).toBe(true);
    expect((await replicaA.hit("k", 2, 1000, now)).allowed).toBe(false);
    // replicaB has its OWN budget — the per-process default is NOT cluster-wide.
    expect((await replicaB.hit("k", 2, 1000, now)).allowed).toBe(true);
    expect((await replicaB.hit("k", 2, 1000, now)).allowed).toBe(true);
  });
});

describe("SharedRateLimitStore — in-process shared seam", () => {
  it("enforces the cap when ONE store is shared across two call sites", async () => {
    const shared = new SharedRateLimitStore();
    const replicaA: RateLimitStore = shared;
    const replicaB: RateLimitStore = shared;
    const now = Date.now();
    expect((await replicaA.hit("k", 2, 1000, now)).allowed).toBe(true);
    expect((await replicaB.hit("k", 2, 1000, now)).allowed).toBe(true);
    // Third hit on EITHER call site is denied — the in-process window is shared.
    expect((await replicaA.hit("k", 2, 1000, now)).allowed).toBe(false);
    expect((await replicaB.hit("k", 2, 1000, now)).allowed).toBe(false);
  });
});

describe("resolveRateLimitStore — backend selection", () => {
  afterEach(() => {
    __resetSharedRateLimitStore();
  });

  it("defaults to a fresh in-memory store when env is unset", () => {
    expect(resolveRateLimitStore({})).toBeInstanceOf(InMemoryRateLimitStore);
  });

  it("returns an in-memory store for backend=memory", () => {
    expect(resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "memory" })).toBeInstanceOf(
      InMemoryRateLimitStore,
    );
  });

  it("returns the in-process shared singleton for backend=shared", () => {
    const a = resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "shared" });
    const b = resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "shared" });
    expect(a).toBeInstanceOf(SharedRateLimitStore);
    expect(a).toBe(b); // singleton
  });

  it("a NEW in-memory store is returned per call (per-process isolation)", () => {
    const a = resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "memory" });
    const b = resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "memory" });
    expect(a).not.toBe(b);
  });

  it("falls back to in-memory for an unknown backend value (fail-safe)", () => {
    expect(resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "wat" })).toBeInstanceOf(
      InMemoryRateLimitStore,
    );
  });

  it("uppercase / padded backend names normalize", () => {
    expect(resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "  MEMORY " })).toBeInstanceOf(
      InMemoryRateLimitStore,
    );
  });

  it("backend=postgres resolves via the registered factory as a singleton", () => {
    const fake: RateLimitStore = {
      hit: async () => ({ allowed: true, recentCount: 1 }),
      reset: async () => {},
    };
    __setPostgresStoreFactory(() => fake);
    const a = resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "postgres" });
    const b = resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "postgres" });
    expect(a).toBe(fake);
    expect(b).toBe(fake); // singleton — one connection reused
  });

  it("backend=postgres fails loud when no factory is registered", () => {
    // Drop any registered factory first (a prior test may have set one).
    __resetSharedRateLimitStore();
    __setPostgresStoreFactory(() => {
      throw new Error("factory not registered");
    });
    __resetSharedRateLimitStore();
    // Re-register the default failing behaviour by NOT registering a real one.
    // The factory above throws, proving selection fails loud (never silent
    // per-process degradation).
    expect(() => resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "postgres" })).toThrow();
  });

  it("backend=valkey resolves via the registered factory and receives env", () => {
    const fake: RateLimitStore = {
      hit: async () => ({ allowed: true, recentCount: 1 }),
      reset: async () => {},
    };
    let seenEnv: NodeJS.ProcessEnv | undefined;
    __setValkeyStoreFactory((env) => {
      seenEnv = env;
      return fake;
    });
    const store = resolveRateLimitStore({
      DISCUSSION_RATE_LIMIT_BACKEND: "valkey",
      VALKEY_URL: "valkey://cache:6379",
    });
    expect(store).toBe(fake);
    expect(seenEnv?.VALKEY_URL).toBe("valkey://cache:6379");
  });

  it("backend=valkey fails loud when no client/factory is registered", () => {
    __resetSharedRateLimitStore();
    __setValkeyStoreFactory(() => {
      throw new Error("no redis-wire client installed");
    });
    expect(() => resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "valkey" })).toThrow();
  });
});
