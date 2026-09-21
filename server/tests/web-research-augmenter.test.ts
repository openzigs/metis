/**
 * Tests for WebResearchAugmenter (Epic #597 / Issue #623; firewall support #929).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WebResearchAugmenter,
  StubWebSearchProvider,
  TavilySearchProvider,
  BraveSearchProvider,
  GoogleCseProvider,
  scoreDomainTrust,
  shouldBypassProxy,
  getProxyDispatcher,
  createSearchProvider,
} from "../src/lib/analysis/web-research-augmenter.js";
import type { AIProvider, ChatResponse } from "../src/lib/ai/types.js";
import type {
  StructuredRequirement,
  WebSearchProvider,
  WebSearchHit,
} from "../src/lib/analysis/types/requirements.js";

function mockProvider(content: string): AIProvider {
  return {
    key: "test",
    model: "test-model",
    offline: true,
    chat: vi.fn().mockResolvedValue({
      content,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      model: "test-model",
      provider: "test",
    } as ChatResponse),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn().mockResolvedValue([]),
    ping: vi.fn().mockResolvedValue(true),
  };
}

function makeRequirement(overrides?: Partial<StructuredRequirement>): StructuredRequirement {
  return {
    id: "req-1",
    title: "Test Requirement",
    description: "A test requirement",
    type: "functional",
    stakeholders: ["user"],
    priority: "must-have",
    ambiguities: [],
    evidenceNeeds: [
      {
        id: "need-1",
        description: "Need evidence about testing best practices",
        domain: "engineering",
        searchHints: ["testing", "best practices"],
      },
    ],
    rawSource: "raw",
    ...overrides,
  };
}

class MockSearchProvider implements WebSearchProvider {
  results: WebSearchHit[] = [];
  searchCalls: Array<{ query: string; maxResults?: number }> = [];

  async search(query: string, maxResults?: number): Promise<WebSearchHit[]> {
    this.searchCalls.push({ query, maxResults });
    return this.results;
  }
}

describe("WebResearchAugmenter", () => {
  describe("scoreDomainTrust", () => {
    it("returns high for .gov domains", () => {
      expect(scoreDomainTrust("https://www.nist.gov/page")).toBe("high");
    });

    it("returns high for .edu domains", () => {
      expect(scoreDomainTrust("https://mit.edu/research")).toBe("high");
    });

    it("returns high for ieee.org", () => {
      expect(scoreDomainTrust("https://ieee.org/papers")).toBe("high");
    });

    it("returns low for reddit.com", () => {
      expect(scoreDomainTrust("https://www.reddit.com/r/test")).toBe("low");
    });

    it("returns low for quora.com", () => {
      expect(scoreDomainTrust("https://quora.com/q/test")).toBe("low");
    });

    it("returns medium for generic domains", () => {
      expect(scoreDomainTrust("https://example.com/page")).toBe("medium");
    });

    it("returns low for invalid URLs", () => {
      expect(scoreDomainTrust("not-a-url")).toBe("low");
    });
  });

  describe("StubWebSearchProvider", () => {
    it("returns empty results", async () => {
      const provider = new StubWebSearchProvider();
      const results = await provider.search("test query");
      expect(results).toEqual([]);
    });
  });

  describe("createSearchProvider", () => {
    const ENV_KEYS = [
      "WEB_SEARCH_PROVIDER",
      "WEB_SEARCH_API_KEY",
      "BRAVE_SEARCH_API_KEY",
      "GOOGLE_CSE_API_KEY",
      "GOOGLE_CSE_ID",
      "AI_OFFLINE",
    ] as const;
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      saved = {};
      for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it("returns StubWebSearchProvider when nothing configured", () => {
      expect(createSearchProvider()).toBeInstanceOf(StubWebSearchProvider);
    });

    it("returns TavilySearchProvider when legacy WEB_SEARCH_API_KEY is set (no provider)", () => {
      process.env.WEB_SEARCH_API_KEY = "test-key";
      expect(createSearchProvider()).toBeInstanceOf(TavilySearchProvider);
    });

    it("selects Tavily via WEB_SEARCH_PROVIDER=tavily", () => {
      process.env.WEB_SEARCH_PROVIDER = "tavily";
      process.env.WEB_SEARCH_API_KEY = "test-key";
      expect(createSearchProvider()).toBeInstanceOf(TavilySearchProvider);
    });

    it("selects Brave via WEB_SEARCH_PROVIDER=brave", () => {
      process.env.WEB_SEARCH_PROVIDER = "brave";
      process.env.BRAVE_SEARCH_API_KEY = "brave-key";
      expect(createSearchProvider()).toBeInstanceOf(BraveSearchProvider);
    });

    it("selects Google CSE via WEB_SEARCH_PROVIDER=google", () => {
      process.env.WEB_SEARCH_PROVIDER = "google";
      process.env.GOOGLE_CSE_API_KEY = "g-key";
      process.env.GOOGLE_CSE_ID = "cx-id";
      expect(createSearchProvider()).toBeInstanceOf(GoogleCseProvider);
    });

    it("selects stub via WEB_SEARCH_PROVIDER=stub", () => {
      process.env.WEB_SEARCH_PROVIDER = "stub";
      expect(createSearchProvider()).toBeInstanceOf(StubWebSearchProvider);
    });

    it("is case-insensitive for provider names", () => {
      process.env.WEB_SEARCH_PROVIDER = "BRAVE";
      process.env.BRAVE_SEARCH_API_KEY = "brave-key";
      expect(createSearchProvider()).toBeInstanceOf(BraveSearchProvider);
    });

    it("falls back to stub for unknown provider name", () => {
      process.env.WEB_SEARCH_PROVIDER = "bing";
      expect(createSearchProvider()).toBeInstanceOf(StubWebSearchProvider);
    });

    it("falls back to stub when Tavily key missing for selected provider", () => {
      process.env.WEB_SEARCH_PROVIDER = "tavily";
      expect(createSearchProvider()).toBeInstanceOf(StubWebSearchProvider);
    });

    it("falls back to stub when Brave key missing for selected provider", () => {
      process.env.WEB_SEARCH_PROVIDER = "brave";
      expect(createSearchProvider()).toBeInstanceOf(StubWebSearchProvider);
    });

    it("falls back to stub when Google key/id missing for selected provider", () => {
      process.env.WEB_SEARCH_PROVIDER = "google";
      process.env.GOOGLE_CSE_API_KEY = "g-key";
      // GOOGLE_CSE_ID intentionally unset
      expect(createSearchProvider()).toBeInstanceOf(StubWebSearchProvider);
    });

    it("returns stub when AI_OFFLINE=1 even if a provider+key is configured", () => {
      process.env.AI_OFFLINE = "1";
      process.env.WEB_SEARCH_PROVIDER = "brave";
      process.env.BRAVE_SEARCH_API_KEY = "brave-key";
      expect(createSearchProvider()).toBeInstanceOf(StubWebSearchProvider);
    });
  });

  describe("augment", () => {
    it("returns empty result when no evidence needs", async () => {
      const provider = mockProvider("[]");
      const augmenter = new WebResearchAugmenter({ provider });
      const result = await augmenter.augment([makeRequirement({ evidenceNeeds: [] })]);

      expect(result.digests).toEqual([]);
      expect(result.totalSources).toBe(0);
      expect(result.reviewRequired).toBe(0);
    });

    it("returns empty result when requirements array is empty", async () => {
      const provider = mockProvider("[]");
      const augmenter = new WebResearchAugmenter({ provider });
      const result = await augmenter.augment([]);

      expect(result.digests).toEqual([]);
    });

    it("processes evidence needs and produces digests", async () => {
      const provider = mockProvider('["testing best practices", "unit test coverage"]');
      const searchProvider = new MockSearchProvider();
      searchProvider.results = [
        {
          url: "https://nist.gov/testing",
          title: "Testing Guide",
          snippet: "Best practices for testing",
          score: 0.9,
        },
        {
          url: "https://example.com/test",
          title: "Test Tips",
          snippet: "Some testing tips",
          score: 0.7,
        },
      ];

      // Second call for digest generation
      (provider.chat as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          content: '["testing best practices"]',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          model: "test",
          provider: "test",
        })
        .mockResolvedValueOnce({
          content: "Testing best practices involve writing comprehensive unit tests.",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          model: "test",
          provider: "test",
        });

      const augmenter = new WebResearchAugmenter({
        provider,
        searchProvider,
      });
      const result = await augmenter.augment([makeRequirement()]);

      expect(result.digests).toHaveLength(1);
      expect(result.digests[0]!.sources).toHaveLength(2);
      expect(result.digests[0]!.sources[0]!.domainTrust).toBe("high");
      expect(result.digests[0]!.sources[1]!.domainTrust).toBe("medium");
    });

    it("marks digest for human review when sources have low trust", async () => {
      const provider = mockProvider("[]");
      const searchProvider = new MockSearchProvider();
      searchProvider.results = [
        { url: "https://reddit.com/r/test", title: "Reddit Post", snippet: "Info", score: 0.5 },
        { url: "https://example.com/test", title: "Example", snippet: "Info", score: 0.6 },
      ];

      (provider.chat as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          content: '["test query"]',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          model: "test",
          provider: "test",
        })
        .mockResolvedValueOnce({
          content: "Mixed quality results.",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          model: "test",
          provider: "test",
        });

      const augmenter = new WebResearchAugmenter({ provider, searchProvider });
      const result = await augmenter.augment([makeRequirement()]);

      expect(result.digests[0]!.needsHumanReview).toBe(true);
      expect(result.reviewRequired).toBe(1);
    });

    it("returns review-needed digest when no search results found", async () => {
      const provider = mockProvider('["test query"]');
      const searchProvider = new MockSearchProvider();
      // No results

      const augmenter = new WebResearchAugmenter({ provider, searchProvider });
      const result = await augmenter.augment([makeRequirement()]);

      expect(result.digests).toHaveLength(1);
      expect(result.digests[0]!.sources).toEqual([]);
      expect(result.digests[0]!.needsHumanReview).toBe(true);
      expect(result.digests[0]!.digest).toContain("No web sources found");
    });

    it("respects abort signal", async () => {
      const controller = new AbortController();
      controller.abort();

      const provider = mockProvider('["test"]');
      const searchProvider = new MockSearchProvider();
      const augmenter = new WebResearchAugmenter({ provider, searchProvider });
      const result = await augmenter.augment([makeRequirement()], controller.signal);

      expect(result.digests).toEqual([]);
    });

    it("deduplicates search results by URL", async () => {
      const provider = mockProvider("[]");
      const searchProvider = new MockSearchProvider();
      searchProvider.results = [
        { url: "https://example.com/same", title: "Title 1", snippet: "S1", score: 0.9 },
        { url: "https://example.com/same", title: "Title 2", snippet: "S2", score: 0.8 },
        { url: "https://other.com/page", title: "Title 3", snippet: "S3", score: 0.7 },
      ];

      (provider.chat as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          content: '["query"]',
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          model: "test",
          provider: "test",
        })
        .mockResolvedValueOnce({
          content: "Digest text.",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          model: "test",
          provider: "test",
        });

      const augmenter = new WebResearchAugmenter({ provider, searchProvider });
      const result = await augmenter.augment([makeRequirement()]);

      expect(result.digests[0]!.sources).toHaveLength(2);
    });
  });

  describe("generateQueries", () => {
    it("parses query array from LLM", async () => {
      const provider = mockProvider('["query 1", "query 2", "query 3"]');
      const augmenter = new WebResearchAugmenter({ provider });
      const req = makeRequirement();
      const queries = await augmenter.generateQueries(req, req.evidenceNeeds[0]!);

      expect(queries).toEqual(["query 1", "query 2", "query 3"]);
    });

    it("limits to 3 queries", async () => {
      const provider = mockProvider('["q1", "q2", "q3", "q4", "q5"]');
      const augmenter = new WebResearchAugmenter({ provider });
      const req = makeRequirement();
      const queries = await augmenter.generateQueries(req, req.evidenceNeeds[0]!);

      expect(queries).toHaveLength(3);
    });

    it("falls back to evidence need description on parse failure", async () => {
      const provider = mockProvider("not json");
      const augmenter = new WebResearchAugmenter({ provider });
      const req = makeRequirement();
      const queries = await augmenter.generateQueries(req, req.evidenceNeeds[0]!);

      expect(queries).toEqual([req.evidenceNeeds[0]!.description]);
    });

    it("filters non-string items from array", async () => {
      const provider = mockProvider('["valid", 123, null, "also valid"]');
      const augmenter = new WebResearchAugmenter({ provider });
      const req = makeRequirement();
      const queries = await augmenter.generateQueries(req, req.evidenceNeeds[0]!);

      expect(queries).toEqual(["valid", "also valid"]);
    });
  });

  describe("TavilySearchProvider", () => {
    afterEach(() => vi.restoreAllMocks());

    it("parses results and applies trust scoring via WebSource mapping", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ url: "https://nist.gov/a", title: "A", content: "snip", score: 0.9 }],
        }),
      } as Response);

      const hits = await new TavilySearchProvider("k").search("q");
      expect(hits).toEqual([
        { url: "https://nist.gov/a", title: "A", snippet: "snip", score: 0.9 },
      ]);
      expect(scoreDomainTrust(hits[0]!.url)).toBe("high");
      fetchSpy.mockRestore();
    });

    it("returns [] on non-200 without throwing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 503,
        statusText: "Service Unavailable",
      } as Response);
      await expect(new TavilySearchProvider("k").search("q")).resolves.toEqual([]);
    });

    it("returns [] when fetch rejects", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ENOTFOUND"));
      await expect(new TavilySearchProvider("k").search("q")).resolves.toEqual([]);
    });
  });

  describe("BraveSearchProvider", () => {
    afterEach(() => vi.restoreAllMocks());

    it("parses web.results[] into normalized hits", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          web: {
            results: [
              { url: "https://owasp.org/x", title: "OWASP", description: "desc-1" },
              { url: "https://example.com/y", title: "Ex", description: "desc-2" },
            ],
          },
        }),
      } as Response);

      const hits = await new BraveSearchProvider("brave-key").search("q", 3);
      expect(hits).toEqual([
        { url: "https://owasp.org/x", title: "OWASP", snippet: "desc-1" },
        { url: "https://example.com/y", title: "Ex", snippet: "desc-2" },
      ]);
      expect(scoreDomainTrust(hits[0]!.url)).toBe("high");

      // Sends the subscription token header and query/count params.
      const [calledUrl, init] = fetchSpy.mock.calls[0]!;
      expect(String(calledUrl)).toContain("api.search.brave.com");
      expect(String(calledUrl)).toContain("q=q");
      expect(String(calledUrl)).toContain("count=3");
      expect((init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("brave-key");
    });

    it("handles missing web.results gracefully", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({}),
      } as Response);
      await expect(new BraveSearchProvider("k").search("q")).resolves.toEqual([]);
    });

    it("returns [] on non-200 without throwing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 429,
        statusText: "Too Many Requests",
      } as Response);
      await expect(new BraveSearchProvider("k").search("q")).resolves.toEqual([]);
    });

    it("returns [] when fetch rejects", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
      await expect(new BraveSearchProvider("k").search("q")).resolves.toEqual([]);
    });
  });

  describe("GoogleCseProvider", () => {
    afterEach(() => vi.restoreAllMocks());

    it("parses items[] into normalized hits", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({
          items: [
            { link: "https://w3.org/spec", title: "Spec", snippet: "s1" },
            { link: "https://blog.example.com/p", title: "Post", snippet: "s2" },
          ],
        }),
      } as Response);

      const hits = await new GoogleCseProvider("g-key", "cx-id").search("q", 5);
      expect(hits).toEqual([
        { url: "https://w3.org/spec", title: "Spec", snippet: "s1" },
        { url: "https://blog.example.com/p", title: "Post", snippet: "s2" },
      ]);
      expect(scoreDomainTrust(hits[0]!.url)).toBe("high");

      const calledUrl = String(fetchSpy.mock.calls[0]![0]);
      expect(calledUrl).toContain("customsearch/v1");
      expect(calledUrl).toContain("key=g-key");
      expect(calledUrl).toContain("cx=cx-id");
      expect(calledUrl).toContain("num=5");
    });

    it("caps num at 10", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ items: [] }),
      } as Response);
      await new GoogleCseProvider("g-key", "cx-id").search("q", 50);
      expect(String(fetchSpy.mock.calls[0]![0])).toContain("num=10");
    });

    it("returns [] on non-200 without throwing", async () => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      } as Response);
      await expect(new GoogleCseProvider("k", "cx").search("q")).resolves.toEqual([]);
    });

    it("returns [] when fetch rejects", async () => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("timeout"));
      await expect(new GoogleCseProvider("k", "cx").search("q")).resolves.toEqual([]);
    });
  });

  describe("proxy support (#929)", () => {
    const PROXY_KEYS = [
      "HTTPS_PROXY",
      "https_proxy",
      "HTTP_PROXY",
      "http_proxy",
      "NO_PROXY",
      "no_proxy",
    ] as const;
    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      saved = {};
      for (const k of PROXY_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
      }
    });

    afterEach(() => {
      for (const k of PROXY_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
      vi.restoreAllMocks();
    });

    describe("shouldBypassProxy", () => {
      it("returns false when NO_PROXY is unset", () => {
        expect(shouldBypassProxy("api.example.com", undefined)).toBe(false);
      });

      it("bypasses everything with '*'", () => {
        expect(shouldBypassProxy("anything.com", "*")).toBe(true);
      });

      it("matches exact host and subdomains", () => {
        expect(shouldBypassProxy("example.com", "example.com")).toBe(true);
        expect(shouldBypassProxy("api.example.com", "example.com")).toBe(true);
        expect(shouldBypassProxy("api.example.com", ".example.com")).toBe(true);
        expect(shouldBypassProxy("other.com", "example.com")).toBe(false);
      });

      it("supports comma/space separated lists", () => {
        expect(shouldBypassProxy("internal.corp", "foo.com, internal.corp")).toBe(true);
      });
    });

    describe("getProxyDispatcher", () => {
      it("returns undefined when no proxy env is set", () => {
        expect(getProxyDispatcher("https://api.search.brave.com/x")).toBeUndefined();
      });

      it("returns a dispatcher when HTTPS_PROXY is set", () => {
        process.env.HTTPS_PROXY = "http://corp-proxy:8080";
        const dispatcher = getProxyDispatcher("https://api.search.brave.com/x");
        expect(dispatcher).toBeDefined();
      });

      it("returns undefined when host is in NO_PROXY", () => {
        process.env.HTTPS_PROXY = "http://corp-proxy:8080";
        process.env.NO_PROXY = "api.search.brave.com";
        expect(getProxyDispatcher("https://api.search.brave.com/x")).toBeUndefined();
      });

      it("returns undefined for an invalid target URL", () => {
        process.env.HTTPS_PROXY = "http://corp-proxy:8080";
        expect(getProxyDispatcher("not a url")).toBeUndefined();
      });

      it("returns undefined for an invalid proxy URL", () => {
        process.env.HTTPS_PROXY = "::::not-a-valid-proxy::::";
        expect(getProxyDispatcher("https://api.search.brave.com/x")).toBeUndefined();
      });
    });

    it("applies the dispatcher on the fetch init when a proxy is configured", async () => {
      process.env.HTTPS_PROXY = "http://corp-proxy:8080";
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response);

      await new BraveSearchProvider("k").search("q");

      const init = fetchSpy.mock.calls[0]![1] as RequestInit & { dispatcher?: unknown };
      expect(init.dispatcher).toBeDefined();
    });

    it("does NOT set a dispatcher when no proxy is configured", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      } as Response);

      await new BraveSearchProvider("k").search("q");

      const init = fetchSpy.mock.calls[0]![1] as RequestInit & { dispatcher?: unknown };
      expect(init.dispatcher).toBeUndefined();
    });
  });
});
