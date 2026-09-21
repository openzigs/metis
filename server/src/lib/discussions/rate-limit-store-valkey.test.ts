/**
 * Epic #518 (#541) — optional Valkey (redis-wire) rate-limit store tests.
 *
 * Uses a fake redis-wire client that models a single shared Valkey: an atomic
 * EVAL (INCR + PEXPIRE) on a shared keyspace, serialized as Valkey's single
 * command loop serializes concurrent replicas. The cluster-wide proof mirrors
 * the Postgres one: two store instances sharing one fake Valkey hold the cap
 * globally, not Nx.
 */
import { describe, expect, it } from "vitest";

import {
  ValkeyRateLimitStore,
  registerValkeyRateLimitStore,
  type RedisWireClient,
} from "./rate-limit-store-valkey.js";
import { __setValkeyStoreFactory, resolveRateLimitStore } from "./rate-limit-store.js";

/** Fake single-threaded Valkey: one shared map, atomic INCR via serialization. */
class FakeValkey implements RedisWireClient {
  store = new Map<string, number>();
  private tail: Promise<unknown> = Promise.resolve();

  private serialize<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(
      () => new Promise<T>((resolve) => setImmediate(() => resolve(fn()))),
    );
    this.tail = run.catch(() => undefined);
    return run;
  }

  // Models the INCR (+ first-touch PEXPIRE) Lua script.
  eval(_script: string, _numkeys: number, ...args: Array<string | number>): Promise<unknown> {
    const key = String(args[0]);
    return this.serialize(() => {
      const next = (this.store.get(key) ?? 0) + 1;
      this.store.set(key, next);
      return next;
    });
  }

  del(...keys: string[]): Promise<unknown> {
    for (const k of keys) this.store.delete(k);
    return Promise.resolve(keys.length);
  }

  keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, "");
    return Promise.resolve([...this.store.keys()].filter((k) => k.startsWith(prefix)));
  }

  quit(): Promise<unknown> {
    return Promise.resolve("OK");
  }
}

describe("ValkeyRateLimitStore", () => {
  it("allows up to max within a window, then denies", async () => {
    const store = new ValkeyRateLimitStore(new FakeValkey());
    const now = 1_000_000;
    expect((await store.hit("k", 2, 1000, now)).allowed).toBe(true);
    expect((await store.hit("k", 2, 1000, now)).allowed).toBe(true);
    const denied = await store.hit("k", 2, 1000, now);
    expect(denied.allowed).toBe(false);
    expect(denied.oldestTs).toBe(1_000_000);
  });

  it("rolls to a fresh counter when the window advances", async () => {
    const store = new ValkeyRateLimitStore(new FakeValkey());
    expect((await store.hit("k", 1, 1000, 100)).allowed).toBe(true);
    expect((await store.hit("k", 1, 1000, 900)).allowed).toBe(false);
    expect((await store.hit("k", 1, 1000, 1500)).allowed).toBe(true);
  });

  it("reset() clears the namespaced keys", async () => {
    const valkey = new FakeValkey();
    const store = new ValkeyRateLimitStore(valkey);
    await store.hit("k", 1, 1000, 0);
    expect((await store.hit("k", 1, 1000, 0)).allowed).toBe(false);
    await store.reset();
    expect((await store.hit("k", 1, 1000, 0)).allowed).toBe(true);
  });

  it("close() calls quit on the client", async () => {
    const valkey = new FakeValkey();
    let quit = false;
    valkey.quit = () => {
      quit = true;
      return Promise.resolve("OK");
    };
    const store = new ValkeyRateLimitStore(valkey);
    await store.close();
    expect(quit).toBe(true);
  });

  it("tolerates a client without optional keys()/quit()", async () => {
    const minimal: RedisWireClient = {
      eval: async () => 1,
      del: async () => 0,
    };
    const store = new ValkeyRateLimitStore(minimal);
    expect((await store.hit("k", 1, 1000, 0)).allowed).toBe(true);
    await expect(store.reset()).resolves.toBeUndefined();
    await expect(store.close()).resolves.toBeUndefined();
  });

  describe("CLUSTER-WIDE proof: 2 replicas share ONE Valkey", () => {
    it("the cap holds globally (NOT Nx) under concurrent hits", async () => {
      const sharedValkey = new FakeValkey();
      const replicaA = new ValkeyRateLimitStore(sharedValkey);
      const replicaB = new ValkeyRateLimitStore(sharedValkey);
      const max = 4;
      const windowMs = 60_000;
      const now = 2_000_000;
      const key = "thread::user";

      const calls: Array<Promise<{ allowed: boolean }>> = [];
      for (let i = 0; i < 8; i++) {
        calls.push(replicaA.hit(key, max, windowMs, now));
        calls.push(replicaB.hit(key, max, windowMs, now));
      }
      const results = await Promise.all(calls);
      const allowed = results.filter((r) => r.allowed).length;
      expect(allowed).toBe(max); // exactly the cap across BOTH replicas
    });
  });
});

describe("registerValkeyRateLimitStore", () => {
  it("wires the resolver so backend=valkey builds a ValkeyRateLimitStore from a client builder", () => {
    registerValkeyRateLimitStore(() => new FakeValkey());
    const store = resolveRateLimitStore({ DISCUSSION_RATE_LIMIT_BACKEND: "valkey" });
    expect(store).toBeInstanceOf(ValkeyRateLimitStore);
    // Restore fail-loud default for other suites.
    __setValkeyStoreFactory(() => {
      throw new Error("not registered");
    });
  });
});
