/**
 * Epic #518 (#542) — SSO transaction-state store: seam + in-memory backend.
 *
 * These cover the consume-once + TTL contract every backend must honour and the
 * config-driven backend resolution (fail-safe default; fail-loud unregistered
 * postgres). The cluster-wide Postgres behaviour is proven separately in
 * sso-state-store-postgres.test.ts (fake shared Postgres) and the gated
 * sso-state-store-postgres.integration.test.ts (real Postgres).
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  __resetSSOStateStore,
  __setPostgresSSOStateStoreFactory,
  InMemorySSOStateStore,
  resolveSSOStateStore,
  type SSOStatePayload,
  type SSOStateStore,
} from "./sso-state-store.js";

const payload: SSOStatePayload = {
  codeVerifier: "verifier-abc",
  nonce: "nonce-xyz",
  mode: "oidc",
};

afterEach(() => {
  __resetSSOStateStore();
  // Restore the fail-loud default factory so suites don't leak a registration.
  __setPostgresSSOStateStoreFactory(() => {
    throw new Error("not registered");
  });
});

describe("InMemorySSOStateStore — consume-once + TTL", () => {
  it("stores then consumes the payload once", async () => {
    const store = new InMemorySSOStateStore();
    await store.put("state-1", payload, 60_000, 1000);
    const got = await store.consume("state-1", 2000);
    expect(got).toEqual(payload);
  });

  it("rejects a replay: a second consume of the same state returns null", async () => {
    const store = new InMemorySSOStateStore();
    await store.put("state-1", payload, 60_000, 1000);
    expect(await store.consume("state-1", 2000)).toEqual(payload);
    // The state was consumed (deleted) — replaying it must fail.
    expect(await store.consume("state-1", 2000)).toBeNull();
  });

  it("returns null for an unknown state", async () => {
    const store = new InMemorySSOStateStore();
    expect(await store.consume("never-issued")).toBeNull();
  });

  it("rejects an expired state and removes it", async () => {
    const store = new InMemorySSOStateStore();
    await store.put("state-1", payload, 1000, 0); // expires at 1000
    // Consume past the TTL — rejected.
    expect(await store.consume("state-1", 1001)).toBeNull();
    // And it's gone (consume-once even on the expired path).
    expect(await store.consume("state-1", 500)).toBeNull();
  });

  it("treats the expiry boundary as expired (expiresAt <= now)", async () => {
    const store = new InMemorySSOStateStore();
    await store.put("state-1", payload, 1000, 0); // expires at 1000
    expect(await store.consume("state-1", 1000)).toBeNull();
  });

  it("keeps distinct states independent", async () => {
    const store = new InMemorySSOStateStore();
    const other: SSOStatePayload = { codeVerifier: "v2", nonce: "n2", mode: "oidc" };
    await store.put("a", payload, 60_000, 0);
    await store.put("b", other, 60_000, 0);
    expect(await store.consume("a", 10)).toEqual(payload);
    // Consuming "a" must not touch "b".
    expect(await store.consume("b", 10)).toEqual(other);
  });

  it("sweeps expired entries on put so the map stays bounded", async () => {
    const store = new InMemorySSOStateStore();
    await store.put("old", payload, 1000, 0); // expires at 1000
    // A later put past the old TTL sweeps the stale entry.
    await store.put("new", payload, 1000, 5000);
    // The swept entry is gone (consume returns null, not the payload).
    expect(await store.consume("old", 5001)).toBeNull();
    expect(await store.consume("new", 5001)).toEqual(payload);
  });

  it("reset() clears all state", async () => {
    const store = new InMemorySSOStateStore();
    await store.put("a", payload, 60_000, 0);
    await store.reset();
    expect(await store.consume("a", 10)).toBeNull();
  });

  it("defaults now to Date.now() when not injected", async () => {
    const store = new InMemorySSOStateStore();
    await store.put("a", payload, 60_000);
    expect(await store.consume("a")).toEqual(payload);
  });
});

describe("resolveSSOStateStore — backend selection", () => {
  it("defaults to a fresh in-memory store", () => {
    const store = resolveSSOStateStore({});
    expect(store).toBeInstanceOf(InMemorySSOStateStore);
  });

  it("falls back to in-memory for an unknown backend (fail-safe)", () => {
    const store = resolveSSOStateStore({ SSO_STATE_BACKEND: "bogus" });
    expect(store).toBeInstanceOf(InMemorySSOStateStore);
  });

  it("returns a fresh in-memory instance each call (per-process isolation)", () => {
    const a = resolveSSOStateStore({ SSO_STATE_BACKEND: "memory" });
    const b = resolveSSOStateStore({ SSO_STATE_BACKEND: "memory" });
    expect(a).not.toBe(b);
  });

  it("is case/space-insensitive on the backend name", () => {
    const store = resolveSSOStateStore({ SSO_STATE_BACKEND: "  MEMORY " });
    expect(store).toBeInstanceOf(InMemorySSOStateStore);
  });

  it("fails loud when postgres is selected but no factory is registered", () => {
    // The afterEach restores a throwing default factory; selecting postgres must
    // surface that as an error rather than silently degrading to per-process
    // (which would re-introduce the cross-replica bug #542 fixes).
    expect(() => resolveSSOStateStore({ SSO_STATE_BACKEND: "postgres" })).toThrow();
  });

  it("uses the registered postgres factory and returns it as a singleton", () => {
    const fake: SSOStateStore = {
      put: async () => undefined,
      consume: async () => null,
      reset: async () => undefined,
    };
    __setPostgresSSOStateStoreFactory(() => fake);
    const a = resolveSSOStateStore({ SSO_STATE_BACKEND: "postgres" });
    const b = resolveSSOStateStore({ SSO_STATE_BACKEND: "postgres" });
    expect(a).toBe(fake);
    expect(b).toBe(fake); // singleton — built once
  });

  it("__resetSSOStateStore drops the postgres singleton so it rebuilds", () => {
    let built = 0;
    const fake: SSOStateStore = {
      put: async () => undefined,
      consume: async () => null,
      reset: async () => undefined,
    };
    __setPostgresSSOStateStoreFactory(() => {
      built += 1;
      return fake;
    });
    resolveSSOStateStore({ SSO_STATE_BACKEND: "postgres" });
    expect(built).toBe(1);
    __resetSSOStateStore();
    resolveSSOStateStore({ SSO_STATE_BACKEND: "postgres" });
    expect(built).toBe(2);
  });
});
