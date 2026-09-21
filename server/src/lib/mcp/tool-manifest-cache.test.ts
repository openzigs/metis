/**
 * Epic #502 / Issue #506 — Unit tests for ToolManifestCache.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { ToolManifestCache } from "./tool-manifest-cache.js";

describe("ToolManifestCache", () => {
  let cache: ToolManifestCache;

  beforeEach(() => {
    cache = new ToolManifestCache({ ttlMs: 5000 });
  });

  describe("get/set", () => {
    it("returns null for cache miss", () => {
      const result = cache.get(["tool-a", "tool-b"], "compact");
      expect(result).toBeNull();
    });

    it("returns cached content on hit", () => {
      cache.set(["tool-a", "tool-b"], "compact", "cached manifest content");
      const result = cache.get(["tool-a", "tool-b"], "compact");
      expect(result).toBe("cached manifest content");
    });

    it("is order-independent for tool IDs (sorted internally)", () => {
      cache.set(["tool-b", "tool-a"], "compact", "content");
      const result = cache.get(["tool-a", "tool-b"], "compact");
      expect(result).toBe("content");
    });

    it("differentiates by manifest mode", () => {
      cache.set(["tool-a"], "compact", "compact content");
      cache.set(["tool-a"], "full", "full content");

      expect(cache.get(["tool-a"], "compact")).toBe("compact content");
      expect(cache.get(["tool-a"], "full")).toBe("full content");
    });

    it("differentiates by tool set", () => {
      cache.set(["tool-a"], "compact", "content-a");
      cache.set(["tool-a", "tool-b"], "compact", "content-ab");

      expect(cache.get(["tool-a"], "compact")).toBe("content-a");
      expect(cache.get(["tool-a", "tool-b"], "compact")).toBe("content-ab");
    });
  });

  describe("TTL expiration", () => {
    it("returns null for expired entries", () => {
      vi.useFakeTimers();

      cache.set(["tool-a"], "compact", "content");
      expect(cache.get(["tool-a"], "compact")).toBe("content");

      // Advance past TTL
      vi.advanceTimersByTime(6000);

      expect(cache.get(["tool-a"], "compact")).toBeNull();

      vi.useRealTimers();
    });

    it("returns content before TTL expires", () => {
      vi.useFakeTimers();

      cache.set(["tool-a"], "compact", "content");

      vi.advanceTimersByTime(4999);
      expect(cache.get(["tool-a"], "compact")).toBe("content");

      vi.useRealTimers();
    });
  });

  describe("invalidation", () => {
    it("clears all entries on invalidate()", () => {
      cache.set(["tool-a"], "compact", "a");
      cache.set(["tool-b"], "compact", "b");

      expect(cache.size).toBe(2);
      cache.invalidate();
      expect(cache.size).toBe(0);
      expect(cache.get(["tool-a"], "compact")).toBeNull();
    });

    it("invalidateForTools clears cache", () => {
      cache.set(["tool-a", "tool-b"], "compact", "content");
      cache.invalidateForTools(["tool-a"]);
      expect(cache.get(["tool-a", "tool-b"], "compact")).toBeNull();
    });
  });

  describe("metrics", () => {
    it("tracks hits and misses", () => {
      cache.set(["tool-a"], "compact", "content");

      cache.get(["tool-a"], "compact"); // hit
      cache.get(["tool-b"], "compact"); // miss
      cache.get(["tool-a"], "compact"); // hit

      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(2);
      expect(metrics.misses).toBe(1);
      expect(metrics.hitRate).toBeCloseTo(2 / 3);
    });

    it("tracks invalidations", () => {
      cache.set(["tool-a"], "compact", "a");
      cache.set(["tool-b"], "compact", "b");
      cache.invalidate();

      const metrics = cache.getMetrics();
      expect(metrics.invalidations).toBe(2);
    });

    it("returns 0 hit rate when no operations", () => {
      const metrics = cache.getMetrics();
      expect(metrics.hitRate).toBe(0);
    });

    it("resets metrics", () => {
      cache.set(["tool-a"], "compact", "content");
      cache.get(["tool-a"], "compact");
      cache.resetMetrics();

      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(0);
    });
  });

  describe("size", () => {
    it("reports correct cache size", () => {
      expect(cache.size).toBe(0);
      cache.set(["tool-a"], "compact", "a");
      expect(cache.size).toBe(1);
      cache.set(["tool-b"], "compact", "b");
      expect(cache.size).toBe(2);
    });
  });
});
