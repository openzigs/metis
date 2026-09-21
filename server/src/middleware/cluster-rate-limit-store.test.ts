import { describe, expect, it, vi } from "vitest";
import type { Options } from "express-rate-limit";
import { ClusterRateLimitStore } from "./cluster-rate-limit-store.js";
import {
  InMemoryRateLimitStore,
  type RateLimitStore,
} from "../lib/discussions/rate-limit-store.js";

const OPTS = { windowMs: 60_000 } as unknown as Options;

/** A cluster store bound to a specific backend (simulates ONE replica). */
function replica(backing: RateLimitStore, prefix = "auth"): ClusterRateLimitStore {
  const s = new ClusterRateLimitStore(prefix, () => backing);
  s.init(OPTS);
  return s;
}

describe("ClusterRateLimitStore — cross-instance (cluster-wide) counting (#679)", () => {
  it("shares one counter across two instances backed by one store (two replicas)", async () => {
    const shared = new InMemoryRateLimitStore();
    const a = replica(shared);
    const b = replica(shared);
    // Same IP, hits alternating across the two replicas — the count is shared.
    expect((await a.increment("1.2.3.4")).totalHits).toBe(1);
    expect((await b.increment("1.2.3.4")).totalHits).toBe(2);
    expect((await a.increment("1.2.3.4")).totalHits).toBe(3);
    // A different IP is independent.
    expect((await b.increment("9.9.9.9")).totalHits).toBe(1);
  });

  it("namespaces by prefix so distinct limiters never collide on the same key", async () => {
    const shared = new InMemoryRateLimitStore();
    const auth = replica(shared, "auth");
    const ai = replica(shared, "ai");
    await auth.increment("1.2.3.4");
    await auth.increment("1.2.3.4");
    // Same IP through a different limiter starts its own count.
    expect((await ai.increment("1.2.3.4")).totalHits).toBe(1);
  });

  it("resolves the backing store lazily — never at construction (import-order safety)", async () => {
    const resolve = vi.fn(() => new InMemoryRateLimitStore());
    const s = new ClusterRateLimitStore("auth", resolve);
    s.init(OPTS);
    expect(resolve).not.toHaveBeenCalled();
    await s.increment("1.2.3.4");
    expect(resolve).toHaveBeenCalledTimes(1);
    await s.increment("1.2.3.4");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("returns a resetTime and treats decrement/resetKey as safe no-ops", async () => {
    const s = replica(new InMemoryRateLimitStore());
    const res = await s.increment("1.2.3.4");
    expect(res.resetTime).toBeInstanceOf(Date);
    await expect(s.decrement()).resolves.toBeUndefined();
    await expect(s.resetKey()).resolves.toBeUndefined();
  });
});
