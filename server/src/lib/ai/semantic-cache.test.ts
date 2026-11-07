/**
 * Epic #647 / Issue #651 — Semantic Response Cache unit tests.
 * #1844 — scoped to the content version, caller and conversation; exact match
 * first; 0.97 by default; no tool-using turn stored; off by default.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  DEFAULT_SEMANTIC_CACHE_THRESHOLD,
  SemanticResponseCache,
  UNSCOPED_CONTENT_VERSION,
  buildSemanticCacheScope,
  contentVersionUnchanged,
  cosineSimilarity,
  normalizeQuery,
  shouldSkipCache,
  shouldStoreTurn,
  loadCacheConfig,
  type SemanticCacheScope,
} from "./semantic-cache.js";
import type { ProjectContentVersion } from "../projects/content-version.js";
import type { ChatMessage } from "./types.js";

const SCOPE: SemanticCacheScope = {
  model: "model-a",
  systemPromptHash: "hash1",
  projectId: "proj-1",
  contentVersion: "v1",
  callerScope: "u1",
  conversationHash: "c1",
};
const q = (embedding: number[], text = `q-${embedding.join(",")}`) => ({ text, embedding });

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
      await disabled.store(q([1, 0, 0]), SCOPE, "response");
      expect(await disabled.lookup(q([1, 0, 0]), SCOPE)).toBeNull();
    });

    it("returns null when no entries match", async () => {
      expect(await cache.lookup(q([1, 0, 0]), SCOPE)).toBeNull();
    });

    it("returns a hit when similarity exceeds threshold", async () => {
      await cache.store(q([1, 0, 0, 0], "first wording"), SCOPE, "cached response");
      const hit = await cache.lookup(q([1, 0, 0, 0], "second wording"), SCOPE);
      expect(hit).toMatchObject({ response: "cached response", match: "similar" });
      expect(hit!.similarity).toBeCloseTo(1.0, 5);
    });

    it("returns null when similarity is below threshold", async () => {
      await cache.store(q([1, 0, 0, 0]), SCOPE, "cached response");
      expect(await cache.lookup(q([0, 1, 0, 0]), SCOPE)).toBeNull();
    });

    it.each<[string, Partial<SemanticCacheScope>]>([
      ["model", { model: "model-b" }],
      ["systemPromptHash", { systemPromptHash: "hash2" }],
      ["projectId", { projectId: "proj-2" }],
      ["content version", { contentVersion: "v2" }],
      ["caller", { callerScope: "u2" }],
      ["conversation", { conversationHash: "c2" }],
    ])("filters by %s — on both the exact and the similarity path", async (_label, change) => {
      await cache.store(q([1, 0, 0], "same words"), SCOPE, "response");
      expect(await cache.lookup(q([1, 0, 0], "same words"), { ...SCOPE, ...change })).toBeNull();
      expect(await cache.lookup(q([1, 0, 0], "other words"), { ...SCOPE, ...change })).toBeNull();
      expect(await cache.lookup(q([1, 0, 0], "same words"), SCOPE)).not.toBeNull();
    });

    it("an entry stored before a re-ingest is not returned after it", async () => {
      await cache.store(q([1, 0, 0], "which files handle refunds?"), SCOPE, "refunds.go");
      const afterReingest = { ...SCOPE, contentVersion: "v2-after-reingest" };
      expect(
        await cache.lookup(q([1, 0, 0], "which files handle refunds?"), afterReingest),
      ).toBeNull();
    });

    it("tries an exact normalised-text match first, whatever the embedding says", async () => {
      await cache.store(q([1, 0, 0], "Which files  handle\nREFUNDS?"), SCOPE, "exact answer");
      // An orthogonal embedding (similarity 0) still hits on the same words.
      const hit = await cache.lookup(q([0, 1, 0], "  which files handle refunds?  "), SCOPE);
      expect(hit).toMatchObject({ response: "exact answer", match: "exact", similarity: 1 });
    });

    it("an exact match beats a closer embedding neighbour", async () => {
      await cache.store(q([1, 0, 0], "neighbour"), SCOPE, "neighbour answer");
      await cache.store(q([0, 1, 0], "the question"), SCOPE, "exact answer");
      const hit = await cache.lookup(q([1, 0, 0], "the question"), SCOPE);
      expect(hit).toMatchObject({ response: "exact answer", match: "exact" });
    });

    it("the newest exact entry wins", async () => {
      await cache.store(q([1, 0, 0], "the question"), SCOPE, "older");
      await cache.store(q([1, 0, 0], "the question"), SCOPE, "newer");
      expect((await cache.lookup(q([1, 0, 0], "the question"), SCOPE))!.response).toBe("newer");
    });

    it("respects TTL — evicts expired entries", async () => {
      const shortTtl = new SemanticResponseCache({ enabled: true, threshold: 0.9, ttlMinutes: 1 });
      await shortTtl.store(q([1, 0, 0]), SCOPE, "response");
      (shortTtl as unknown as { entries: { createdAt: Date }[] }).entries[0].createdAt = new Date(
        Date.now() - 120_000,
      );
      expect(await shortTtl.lookup(q([1, 0, 0]), SCOPE)).toBeNull();
    });

    it("returns the best match when multiple entries exist", async () => {
      await cache.store(q([0.8, 0.6, 0, 0], "a"), SCOPE, "less similar response");
      await cache.store(q([1, 0, 0, 0], "b"), SCOPE, "exact response");
      const hit = await cache.lookup(q([0.99, 0.01, 0, 0], "c"), SCOPE);
      expect(hit!.response).toBe("exact response");
    });

    it("at the default threshold a 0.95 neighbour is a miss and a 0.98 one a hit", async () => {
      const strict = new SemanticResponseCache({ enabled: true });
      // cos([1,0], [x, sqrt(1-x²)]) = x
      const at = (x: number) => [x, Math.sqrt(1 - x * x)];
      await strict.store(q([1, 0], "stored"), SCOPE, "answer");
      expect(await strict.lookup(q(at(0.95), "near miss"), SCOPE)).toBeNull();
      expect(await strict.lookup(q(at(0.98), "paraphrase"), SCOPE)).toMatchObject({
        match: "similar",
      });
    });
  });

  describe("lookupExact (#1865)", () => {
    it("returns the newest exact entry in scope, with no embedding asked for", async () => {
      await cache.store(q([1, 0, 0], "the question"), SCOPE, "older");
      await cache.store(q([0, 1, 0], "the question"), SCOPE, "newer");
      await cache.store(q([0, 0, 1], "another question"), SCOPE, "other");
      expect(cache.lookupExact("  THE question ", SCOPE)).toMatchObject({
        response: "newer",
        match: "exact",
        similarity: 1,
      });
    });

    it("misses on other words, another scope, an expired entry, or a disabled cache", async () => {
      await cache.store(q([1, 0, 0], "the question"), SCOPE, "answer");
      expect(cache.lookupExact("a near-identical question", SCOPE)).toBeNull();
      expect(cache.lookupExact("the question", { ...SCOPE, callerScope: "u2" })).toBeNull();
      (cache as unknown as { entries: { createdAt: Date }[] }).entries[0].createdAt = new Date(
        Date.now() - 31 * 60_000,
      );
      expect(cache.lookupExact("the question", SCOPE)).toBeNull();
      expect(new SemanticResponseCache({ enabled: false }).lookupExact("x", SCOPE)).toBeNull();
    });
  });

  describe("contentVersionUnchanged (#1865)", () => {
    const version = (key: string, complete = true): ProjectContentVersion => ({
      codeShas: {},
      docsVersion: "d",
      key,
      complete,
    });

    it("compares only the project's content version, read now", async () => {
      const asked: string[] = [];
      const read =
        (key: string, complete = true) =>
        async (projectId: string) => {
          asked.push(projectId);
          return version(key, complete);
        };
      expect(await contentVersionUnchanged(SCOPE, read("v1"))).toBe(true);
      expect(await contentVersionUnchanged(SCOPE, read("v2"))).toBe(false);
      // The same key, but no longer complete: never stored.
      expect(await contentVersionUnchanged(SCOPE, read("v1", false))).toBe(false);
      expect(asked).toEqual(["proj-1", "proj-1", "proj-1"]);
    });

    it("holds for a session with no project, without reading a version", async () => {
      const unscoped = { ...SCOPE, projectId: null, contentVersion: UNSCOPED_CONTENT_VERSION };
      expect(
        await contentVersionUnchanged(unscoped, async () => {
          throw new Error("must not be read");
        }),
      ).toBe(true);
    });
  });

  describe("store", () => {
    it("does not store when disabled", async () => {
      const disabled = new SemanticResponseCache({ enabled: false });
      await disabled.store(q([1, 0, 0]), SCOPE, "resp");
      expect(disabled.size).toBe(0);
    });

    it("increments size", async () => {
      expect(cache.size).toBe(0);
      await cache.store(q([1, 0, 0]), SCOPE, "resp");
      expect(cache.size).toBe(1);
    });

    it("evicts expired entries on store", async () => {
      const shortTtl = new SemanticResponseCache({ enabled: true, threshold: 0.9, ttlMinutes: 1 });
      await shortTtl.store(q([1, 0, 0]), SCOPE, "old");
      (shortTtl as unknown as { entries: { createdAt: Date }[] }).entries[0].createdAt = new Date(
        Date.now() - 120_000,
      );
      await shortTtl.store(q([0, 1, 0]), SCOPE, "new");
      expect(shortTtl.size).toBe(1);
    });

    it("enforces maxEntries cap by evicting oldest entries", async () => {
      const capped = new SemanticResponseCache({
        enabled: true,
        threshold: 0.9,
        ttlMinutes: 30,
        maxEntries: 3,
      });
      await capped.store(q([1, 0, 0]), SCOPE, "first");
      await capped.store(q([0, 1, 0]), SCOPE, "second");
      await capped.store(q([0, 0, 1]), SCOPE, "third");
      expect(capped.size).toBe(3);
      await capped.store(q([1, 1, 0]), SCOPE, "fourth");
      expect(capped.size).toBe(3);
      expect(await capped.lookup(q([1, 0, 0]), SCOPE)).toBeNull();
    });
  });

  describe("clear", () => {
    it("removes all entries", async () => {
      await cache.store(q([1, 0, 0]), SCOPE, "resp");
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

  describe("shouldStoreTurn (#1844)", () => {
    it("never stores a turn whose answer used a tool", () => {
      expect(shouldStoreTurn({ response: "refunds.go handles it", toolCallCount: 1 })).toBe(false);
      expect(shouldStoreTurn({ response: "refunds.go handles it", toolCallCount: 3 })).toBe(false);
    });

    it("stores a tool-free turn unless the response itself is skipped", () => {
      expect(shouldStoreTurn({ response: "a plain answer", toolCallCount: 0 })).toBe(true);
      expect(shouldStoreTurn({ response: "[REDACTED]", toolCallCount: 0 })).toBe(false);
    });
  });

  describe("normalizeQuery", () => {
    it("folds case, width and whitespace, and nothing else", () => {
      expect(normalizeQuery("  Which\tFILES\n\nhandle ｒｅｆｕｎｄｓ? ")).toBe(
        "which files handle refunds?",
      );
      expect(normalizeQuery("refunds?")).not.toBe(normalizeQuery("refunds."));
    });
  });

  describe("buildSemanticCacheScope (#1844)", () => {
    const version = (key: string, complete = true): ProjectContentVersion => ({
      codeShas: {},
      docsVersion: "d",
      key,
      complete,
    });
    const messages = (history: ChatMessage[], system = "persona"): ChatMessage[] => [
      { role: "system", content: system },
      ...history,
      { role: "user", content: "the question" },
    ];
    const build = (over: Partial<Parameters<typeof buildSemanticCacheScope>[0]> = {}) =>
      buildSemanticCacheScope({
        model: "m",
        messages: messages([]),
        projectId: "p1",
        userId: "u1",
        version: async () => version("v1"),
        ...over,
      });

    it("takes the project's content version key and the caller", async () => {
      expect(await build()).toMatchObject({
        model: "m",
        projectId: "p1",
        contentVersion: "v1",
        callerScope: "u1",
      });
    });

    it("returns null — no caching — when the content version is incomplete", async () => {
      expect(await build({ version: async () => version("v1", false) })).toBeNull();
    });

    it("marks a session with no project and never reads a version for it", async () => {
      const scope = await build({
        projectId: null,
        version: async () => {
          throw new Error("must not be read");
        },
      });
      expect(scope?.contentVersion).toBe(UNSCOPED_CONTENT_VERSION);
    });

    it("hashes the system messages and the conversation before the question, apart", async () => {
      const base = (await build())!;
      const otherSystem = (await build({ messages: messages([], "another persona") }))!;
      const withHistory = (await build({
        messages: messages([
          { role: "user", content: "list the services" },
          { role: "assistant", content: "billing, refunds" },
        ]),
      }))!;
      expect(otherSystem.systemPromptHash).not.toBe(base.systemPromptHash);
      expect(otherSystem.conversationHash).toBe(base.conversationHash);
      expect(withHistory.conversationHash).not.toBe(base.conversationHash);
      expect(withHistory.systemPromptHash).toBe(base.systemPromptHash);
      // The question itself is not part of the conversation hash.
      const otherQuestion = (await build({
        messages: [
          { role: "system", content: "persona" },
          { role: "user", content: "a different question" },
        ],
      }))!;
      expect(otherQuestion.conversationHash).toBe(base.conversationHash);
    });
  });

  describe("loadCacheConfig", () => {
    const KEYS = [
      "SEMANTIC_CACHE_ENABLED",
      "SEMANTIC_CACHE_THRESHOLD",
      "SEMANTIC_CACHE_TTL_MINUTES",
      "SEMANTIC_CACHE_MAX_ENTRIES",
    ];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => {
      for (const k of KEYS) saved[k] = process.env[k];
    });
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("is OFF by default, at 0.97, with the old TTL and size", () => {
      for (const k of KEYS) delete process.env[k];
      const config = loadCacheConfig();
      expect(config.enabled).toBe(false);
      expect(config.threshold).toBe(0.97);
      expect(DEFAULT_SEMANTIC_CACHE_THRESHOLD).toBe(0.97);
      expect(config.ttlMinutes).toBe(30);
      expect(config.maxEntries).toBe(1000);
      expect(new SemanticResponseCache().enabled).toBe(false);
    });

    it("reads env vars when set; SEMANTIC_CACHE_THRESHOLD still overrides", () => {
      process.env.SEMANTIC_CACHE_ENABLED = "1";
      process.env.SEMANTIC_CACHE_THRESHOLD = "0.85";
      process.env.SEMANTIC_CACHE_TTL_MINUTES = "60";
      process.env.SEMANTIC_CACHE_MAX_ENTRIES = "500";
      const config = loadCacheConfig();
      expect(config.enabled).toBe(true);
      expect(config.threshold).toBe(0.85);
      expect(config.ttlMinutes).toBe(60);
      expect(config.maxEntries).toBe(500);
    });
  });
});
