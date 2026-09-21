/**
 * Epic #647 / Issue #651 — Semantic Response Cache unit tests.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  SemanticResponseCache,
  cosineSimilarity,
  shouldSkipCache,
  loadCacheConfig,
} from "./semantic-cache.js";

describe("SemanticResponseCache", () => {
  let cache: SemanticResponseCache;

  beforeEach(() => {
    cache = new SemanticResponseCache({ enabled: true, threshold: 0.9, ttlMinutes: 30 });
  });

  describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
      const v = [1, 0, 0, 1];
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
    });

    it("returns 0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 5);
    });

    it("returns 0 for empty vectors", () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it("returns 0 for mismatched lengths", () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it("computes correct similarity for known vectors", () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3.01]; // very similar
      expect(cosineSimilarity(a, b)).toBeGreaterThan(0.99);
    });
  });

  describe("lookup", () => {
    it("returns null when cache is disabled", async () => {
      const disabled = new SemanticResponseCache({ enabled: false });
      await disabled.store([1, 0, 0], "model-a", "hash1", "response");
      const hit = await disabled.lookup([1, 0, 0], "model-a", "hash1");
      expect(hit).toBeNull();
    });

    it("returns null when no entries match", async () => {
      const hit = await cache.lookup([1, 0, 0], "model-a", "hash1");
      expect(hit).toBeNull();
    });

    it("returns a hit when similarity exceeds threshold", async () => {
      const embedding = [1, 0, 0, 0];
      await cache.store(embedding, "model-a", "hash1", "cached response");
      const hit = await cache.lookup(embedding, "model-a", "hash1");
      expect(hit).not.toBeNull();
      expect(hit!.response).toBe("cached response");
      expect(hit!.similarity).toBeCloseTo(1.0, 5);
    });

    it("returns null when similarity is below threshold", async () => {
      await cache.store([1, 0, 0, 0], "model-a", "hash1", "cached response");
      // Orthogonal vector
      const hit = await cache.lookup([0, 1, 0, 0], "model-a", "hash1");
      expect(hit).toBeNull();
    });

    it("filters by model", async () => {
      const embedding = [1, 0, 0];
      await cache.store(embedding, "model-a", "hash1", "response a");
      const hit = await cache.lookup(embedding, "model-b", "hash1");
      expect(hit).toBeNull();
    });

    it("filters by systemPromptHash", async () => {
      const embedding = [1, 0, 0];
      await cache.store(embedding, "model-a", "hash1", "response");
      const hit = await cache.lookup(embedding, "model-a", "hash2");
      expect(hit).toBeNull();
    });

    it("filters by projectId", async () => {
      const embedding = [1, 0, 0];
      await cache.store(embedding, "model-a", "hash1", "response", "proj-1");
      const hit = await cache.lookup(embedding, "model-a", "hash1", "proj-2");
      expect(hit).toBeNull();
    });

    it("respects TTL — evicts expired entries", async () => {
      const shortTtl = new SemanticResponseCache({ enabled: true, threshold: 0.9, ttlMinutes: 1 });
      const embedding = [1, 0, 0];
      await shortTtl.store(embedding, "model-a", "hash1", "response");
      // Manually expire the entry by backdating
      (shortTtl as unknown as { entries: { createdAt: Date }[] }).entries[0].createdAt = new Date(
        Date.now() - 120_000,
      );
      const hit = await shortTtl.lookup(embedding, "model-a", "hash1");
      expect(hit).toBeNull();
    });

    it("returns the best match when multiple entries exist", async () => {
      const base = [1, 0, 0, 0];
      const similar = [0.99, 0.01, 0, 0]; // very similar
      const lessSimilar = [0.8, 0.6, 0, 0]; // less similar
      await cache.store(lessSimilar, "model-a", "hash1", "less similar response");
      await cache.store(base, "model-a", "hash1", "exact response");
      const hit = await cache.lookup(similar, "model-a", "hash1");
      expect(hit).not.toBeNull();
      expect(hit!.response).toBe("exact response");
    });
  });

  describe("store", () => {
    it("does not store when disabled", async () => {
      const disabled = new SemanticResponseCache({ enabled: false });
      await disabled.store([1, 0, 0], "model", "hash", "resp");
      expect(disabled.size).toBe(0);
    });

    it("increments size", async () => {
      expect(cache.size).toBe(0);
      await cache.store([1, 0, 0], "model", "hash", "resp");
      expect(cache.size).toBe(1);
    });

    it("evicts expired entries on store", async () => {
      const shortTtl = new SemanticResponseCache({ enabled: true, threshold: 0.9, ttlMinutes: 1 });
      await shortTtl.store([1, 0, 0], "model", "hash", "old");
      (shortTtl as unknown as { entries: { createdAt: Date }[] }).entries[0].createdAt = new Date(
        Date.now() - 120_000,
      );
      await shortTtl.store([0, 1, 0], "model", "hash", "new");
      expect(shortTtl.size).toBe(1);
    });

    it("enforces maxEntries cap by evicting oldest entries", async () => {
      const capped = new SemanticResponseCache({
        enabled: true,
        threshold: 0.9,
        ttlMinutes: 30,
        maxEntries: 3,
      });
      await capped.store([1, 0, 0], "model", "hash", "first");
      await capped.store([0, 1, 0], "model", "hash", "second");
      await capped.store([0, 0, 1], "model", "hash", "third");
      expect(capped.size).toBe(3);
      await capped.store([1, 1, 0], "model", "hash", "fourth");
      expect(capped.size).toBe(3);
      // The first entry should have been evicted
      const hit = await capped.lookup([1, 0, 0], "model", "hash");
      expect(hit).toBeNull();
    });
  });

  describe("clear", () => {
    it("removes all entries", async () => {
      await cache.store([1, 0, 0], "model", "hash", "resp");
      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe("shouldSkipCache", () => {
    it("returns true for tool call responses", () => {
      expect(shouldSkipCache('{"tool": "search", "args": {}}')).toBe(true);
    });

    it("returns true for safety redactions", () => {
      expect(shouldSkipCache("The content was [REDACTED] for safety.")).toBe(true);
      expect(shouldSkipCache("Content [SAFETY_REDACTED] here.")).toBe(true);
    });

    it("returns false for normal responses", () => {
      expect(shouldSkipCache("Here is a normal helpful response.")).toBe(false);
    });
  });

  describe("loadCacheConfig", () => {
    it("returns defaults when env vars not set", () => {
      const orig = { ...process.env };
      delete process.env.SEMANTIC_CACHE_ENABLED;
      delete process.env.SEMANTIC_CACHE_THRESHOLD;
      delete process.env.SEMANTIC_CACHE_TTL_MINUTES;
      delete process.env.SEMANTIC_CACHE_MAX_ENTRIES;
      const config = loadCacheConfig();
      expect(config.enabled).toBe(false);
      expect(config.threshold).toBe(0.92);
      expect(config.ttlMinutes).toBe(30);
      expect(config.maxEntries).toBe(1000);
      Object.assign(process.env, orig);
    });

    it("reads env vars when set", () => {
      const orig = { ...process.env };
      process.env.SEMANTIC_CACHE_ENABLED = "1";
      process.env.SEMANTIC_CACHE_THRESHOLD = "0.85";
      process.env.SEMANTIC_CACHE_TTL_MINUTES = "60";
      process.env.SEMANTIC_CACHE_MAX_ENTRIES = "500";
      const config = loadCacheConfig();
      expect(config.enabled).toBe(true);
      expect(config.threshold).toBe(0.85);
      expect(config.ttlMinutes).toBe(60);
      expect(config.maxEntries).toBe(500);
      Object.assign(process.env, orig);
    });
  });
});
