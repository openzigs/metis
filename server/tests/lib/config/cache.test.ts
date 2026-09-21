/**
 * Issue #255 — `ConfigCache` unit coverage.
 *
 * The cache is a thin wrapper around `Map<string, CacheEntry>` but it's the
 * critical hot path for tunable reads, so every public method gets a test.
 */
import { describe, expect, it } from "vitest";
import { ConfigCache } from "../../../src/lib/config/cache.js";

describe("ConfigCache", () => {
  it("set + get round-trips a string value with a fetched-at stamp", () => {
    const c = new ConfigCache();
    c.set("AI_PROVIDER", "openai");
    const entry = c.get("AI_PROVIDER");
    expect(entry?.value).toBe("openai");
    expect(typeof entry?.fetchedAt).toBe("number");
  });

  it("getValue returns just the value or undefined", () => {
    const c = new ConfigCache();
    expect(c.getValue("MISSING")).toBeUndefined();
    c.set("FOO", "bar");
    expect(c.getValue("FOO")).toBe("bar");
  });

  it("has reflects insertions and deletions", () => {
    const c = new ConfigCache();
    expect(c.has("X")).toBe(false);
    c.set("X", "1");
    expect(c.has("X")).toBe(true);
    c.invalidate("X");
    expect(c.has("X")).toBe(false);
  });

  it("invalidateAll empties the cache", () => {
    const c = new ConfigCache();
    c.set("A", "1");
    c.set("B", "2");
    expect(c.size()).toBe(2);
    c.invalidateAll();
    expect(c.size()).toBe(0);
    expect(c.keys()).toEqual([]);
  });

  it("keys returns every cached key", () => {
    const c = new ConfigCache();
    c.set("X", "1");
    c.set("Y", "2");
    expect(c.keys().sort()).toEqual(["X", "Y"]);
  });

  it("set overwrites the existing entry and refreshes fetchedAt", async () => {
    const c = new ConfigCache();
    c.set("X", "old");
    const first = c.get("X")!.fetchedAt;
    await new Promise((r) => setTimeout(r, 5));
    c.set("X", "new");
    expect(c.getValue("X")).toBe("new");
    expect(c.get("X")!.fetchedAt).toBeGreaterThanOrEqual(first);
  });
});
