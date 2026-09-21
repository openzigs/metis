/**
 * Epic #517 (#520) — unit tests for the SAML request-id cache.
 *
 * These prove the cache honours node-saml's `CacheProvider` contract exactly —
 * the contract `validateInResponseTo` relies on for replay protection:
 *   - save returns the item once, null on duplicate (no silent overwrite),
 *   - get is non-destructive and returns null for unknown/expired ids,
 *   - remove is the single-use consume (a removed id is gone -> replay misses),
 *   - TTL expiry is enforced on access.
 * Plus the backend resolver: memory by default, postgres only when wired (fail
 * loud otherwise), unknown -> fail-safe memory.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_REQUEST_ID_EXPIRATION_MS,
  InMemorySamlRequestIdCache,
  __resetSamlRequestIdCache,
  __setPostgresSamlRequestIdCacheFactory,
  resolveSamlRequestIdCache,
} from "./saml-request-id-cache.js";

describe("InMemorySamlRequestIdCache", () => {
  it("saveAsync stores a new key and returns the CacheItem", async () => {
    const now = 1_000;
    const cache = new InMemorySamlRequestIdCache(60_000, () => now);

    const item = await cache.saveAsync("req-1", "2026-01-01T00:00:00Z");

    expect(item).toEqual({ value: "2026-01-01T00:00:00Z", createdAt: 1_000 });
  });

  it("saveAsync returns null for a duplicate key (no silent overwrite)", async () => {
    const cache = new InMemorySamlRequestIdCache();

    expect(await cache.saveAsync("req-1", "first")).not.toBeNull();
    expect(await cache.saveAsync("req-1", "second")).toBeNull();
    // Original value is preserved.
    expect(await cache.getAsync("req-1")).toBe("first");
  });

  it("getAsync returns the stored value and is non-destructive", async () => {
    const cache = new InMemorySamlRequestIdCache();
    await cache.saveAsync("req-1", "value-1");

    expect(await cache.getAsync("req-1")).toBe("value-1");
    // Reading again still returns it — get must NOT consume (node-saml calls
    // get then remove as separate steps).
    expect(await cache.getAsync("req-1")).toBe("value-1");
  });

  it("getAsync returns null for an unknown key", async () => {
    const cache = new InMemorySamlRequestIdCache();
    expect(await cache.getAsync("nope")).toBeNull();
  });

  it("removeAsync deletes the key (single-use) and returns it", async () => {
    const cache = new InMemorySamlRequestIdCache();
    await cache.saveAsync("req-1", "value-1");

    expect(await cache.removeAsync("req-1")).toBe("req-1");
    // After remove, a replay (get of the same id) misses -> rejection upstream.
    expect(await cache.getAsync("req-1")).toBeNull();
  });

  it("removeAsync returns null for an unknown or null key", async () => {
    const cache = new InMemorySamlRequestIdCache();
    expect(await cache.removeAsync("missing")).toBeNull();
    expect(await cache.removeAsync(null)).toBeNull();
  });

  it("expires entries past the TTL on getAsync", async () => {
    let now = 0;
    const cache = new InMemorySamlRequestIdCache(1_000, () => now);
    await cache.saveAsync("req-1", "value-1");

    now = 999; // still within TTL
    expect(await cache.getAsync("req-1")).toBe("value-1");

    now = 1_000; // TTL elapsed (>=)
    expect(await cache.getAsync("req-1")).toBeNull();
  });

  it("allows re-saving a key once its prior entry has expired", async () => {
    let now = 0;
    const cache = new InMemorySamlRequestIdCache(1_000, () => now);
    await cache.saveAsync("req-1", "old");

    now = 2_000; // expired
    // saveAsync drops the expired entry first, so the new save succeeds.
    expect(await cache.saveAsync("req-1", "new")).not.toBeNull();
    expect(await cache.getAsync("req-1")).toBe("new");
  });

  it("defaults its TTL to node-saml's 8h request-id expiration", async () => {
    let now = 0;
    const cache = new InMemorySamlRequestIdCache(undefined, () => now);
    await cache.saveAsync("req-1", "v");

    now = DEFAULT_REQUEST_ID_EXPIRATION_MS - 1;
    expect(await cache.getAsync("req-1")).toBe("v");
    now = DEFAULT_REQUEST_ID_EXPIRATION_MS;
    expect(await cache.getAsync("req-1")).toBeNull();
  });
});

describe("resolveSamlRequestIdCache", () => {
  afterEach(() => {
    __resetSamlRequestIdCache();
    vi.restoreAllMocks();
  });

  it("defaults to the in-memory backend", () => {
    const cache = resolveSamlRequestIdCache({} as NodeJS.ProcessEnv);
    expect(cache).toBeInstanceOf(InMemorySamlRequestIdCache);
  });

  it("falls back to memory for an unknown backend (fail-safe)", () => {
    const cache = resolveSamlRequestIdCache({
      SAML_REQUEST_ID_CACHE_BACKEND: "redis",
    } as unknown as NodeJS.ProcessEnv);
    expect(cache).toBeInstanceOf(InMemorySamlRequestIdCache);
  });

  it("returns a fresh memory instance per call (per-process isolation)", () => {
    const a = resolveSamlRequestIdCache({} as NodeJS.ProcessEnv);
    const b = resolveSamlRequestIdCache({} as NodeJS.ProcessEnv);
    expect(a).not.toBe(b);
  });

  it("fails loud when postgres is selected but no factory is registered", () => {
    __resetSamlRequestIdCache();
    // Re-import is unnecessary; the module-level default factory throws.
    expect(() =>
      resolveSamlRequestIdCache({
        SAML_REQUEST_ID_CACHE_BACKEND: "postgres",
      } as NodeJS.ProcessEnv),
    ).toThrow(/Postgres SAML request-id cache factory was not registered/);
  });

  it("uses the registered postgres factory and returns a process-wide singleton", () => {
    const fake = new InMemorySamlRequestIdCache(); // stand-in CacheProvider
    const factory = vi.fn(() => fake);
    __setPostgresSamlRequestIdCacheFactory(factory);

    const first = resolveSamlRequestIdCache({
      SAML_REQUEST_ID_CACHE_BACKEND: "postgres",
    } as NodeJS.ProcessEnv);
    const second = resolveSamlRequestIdCache({
      SAML_REQUEST_ID_CACHE_BACKEND: " POSTGRES ", // trimmed + lowercased
    } as NodeJS.ProcessEnv);

    expect(first).toBe(fake);
    expect(second).toBe(fake);
    expect(factory).toHaveBeenCalledTimes(1); // singleton: built once
  });
});
