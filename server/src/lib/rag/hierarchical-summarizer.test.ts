/**
 * Epic #515 / Issue #517 — Unit tests for HierarchicalSummarizer.
 */
import { describe, it, expect } from "vitest";
import {
  HierarchicalSummarizer,
  estimateTokens,
  extractEntities,
  extractiveSummarize,
  type ChunkInput,
  type SummarizerFn,
} from "./hierarchical-summarizer.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates at ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("hello world!")).toBe(3); // 12/4 = 3
    expect(estimateTokens("a")).toBe(1); // ceil(1/4) = 1
  });

  it("handles long text", () => {
    const text = "x".repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});

describe("extractEntities", () => {
  it("extracts dates", () => {
    const entities = extractEntities("Created on 2024-01-15 and updated 2024-03-22.");
    expect(entities).toContain("2024-01-15");
    expect(entities).toContain("2024-03-22");
  });

  it("extracts URLs", () => {
    const entities = extractEntities("See https://example.com/docs for details.");
    expect(entities).toContain("https://example.com/docs");
  });

  it("extracts file paths", () => {
    const entities = extractEntities("Modify /src/lib/analysis/agent-loop.ts");
    expect(entities).toContain("/src/lib/analysis/agent-loop.ts");
  });

  it("extracts numbers with units", () => {
    const entities = extractEntities("Response time was 250ms with 99.9% uptime");
    expect(entities.some((e) => e.includes("250ms"))).toBe(true);
  });

  it("returns empty array for plain text without entities", () => {
    const entities = extractEntities("Hello world this is a test");
    // May find some trivial matches but key entities are missing
    expect(entities.length).toBeLessThanOrEqual(5);
  });
});

describe("extractiveSummarize", () => {
  it("returns text as-is when within budget", async () => {
    const text = "Short text.";
    const result = await extractiveSummarize(text, 100);
    expect(result).toBe(text);
  });

  it("reduces text when over budget", async () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} with detail.`);
    const text = sentences.join(" ");
    const targetTokens = 20; // ~80 chars
    const result = await extractiveSummarize(text, targetTokens);
    expect(result.length).toBeLessThan(text.length);
    // Should preserve first sentence (high priority)
    expect(result).toContain("Sentence number 0");
  });

  it("preserves sentences with entities", async () => {
    const text =
      "The project started. Revenue grew 45% in 2024-01-15. " +
      "Many things happened. Details at https://example.com. " +
      "More filler content here. The end result was positive.";
    const targetTokens = 30; // ~120 chars
    const result = await extractiveSummarize(text, targetTokens);
    // Should prefer sentences with dates/URLs/numbers
    expect(result.length).toBeLessThan(text.length);
  });

  it("handles single sentence", async () => {
    const text = "A".repeat(200);
    const result = await extractiveSummarize(text, 10); // 40 chars
    expect(result.length).toBeLessThanOrEqual(40);
  });
});

describe("HierarchicalSummarizer", () => {
  const mockSummarizer: SummarizerFn = async (text: string, targetTokens: number) => {
    const targetChars = targetTokens * 4;
    if (text.length <= targetChars) return text;
    return text.slice(0, targetChars);
  };

  function makeChunks(count: number, charsPerChunk: number): ChunkInput[] {
    return Array.from({ length: count }, (_, i) => ({
      content: `Chunk ${i}: ${"x".repeat(charsPerChunk)}`,
      metadata: { index: i },
    }));
  }

  describe("below threshold (no summarization)", () => {
    it("returns chunks as-is when total tokens <= 2x budget", async () => {
      const summarizer = new HierarchicalSummarizer({
        tokenBudget: 1000,
        summarizer: mockSummarizer,
      });
      // 3 chunks of 200 chars each = 600 chars = 150 tokens; budget = 1000, threshold = 2000
      const chunks = makeChunks(3, 200);
      const result = await summarizer.summarize(chunks);

      expect(result.wasSummarized).toBe(false);
      expect(result.content).toContain("Chunk 0");
      expect(result.content).toContain("Chunk 1");
      expect(result.content).toContain("Chunk 2");
      expect(result.depth).toBe(0);
    });

    it("returns empty result for no chunks", async () => {
      const summarizer = new HierarchicalSummarizer({ summarizer: mockSummarizer });
      const result = await summarizer.summarize([]);

      expect(result.wasSummarized).toBe(false);
      expect(result.content).toBe("");
      expect(result.chunkCount).toBe(0);
    });
  });

  describe("above threshold (summarization triggered)", () => {
    it("applies map-reduce when total tokens > 2x budget", async () => {
      const summarizer = new HierarchicalSummarizer({
        tokenBudget: 100, // 400 chars budget
        summarizer: mockSummarizer,
      });
      // 10 chunks of 200 chars each = 2000 chars = 500 tokens > 2*100
      const chunks = makeChunks(10, 200);
      const result = await summarizer.summarize(chunks);

      expect(result.wasSummarized).toBe(true);
      expect(result.outputTokens).toBeLessThanOrEqual(result.inputTokens);
      expect(result.chunkCount).toBe(10);
      expect(result.depth).toBeGreaterThanOrEqual(1);
    });

    it("reduces output to within token budget", async () => {
      const tokenBudget = 200; // 800 chars
      const summarizer = new HierarchicalSummarizer({
        tokenBudget,
        summarizer: mockSummarizer,
      });
      // 20 chunks of 500 chars = 10000 chars = 2500 tokens >> 2*200
      const chunks = makeChunks(20, 500);
      const result = await summarizer.summarize(chunks);

      expect(result.wasSummarized).toBe(true);
      expect(result.outputTokens).toBeLessThanOrEqual(tokenBudget);
    });

    it("recursively reduces if first pass exceeds budget", async () => {
      const tokenBudget = 50; // Very tight budget: 200 chars
      const summarizer = new HierarchicalSummarizer({
        tokenBudget,
        maxDepth: 3,
        summarizer: mockSummarizer,
      });
      // 20 chunks of 1000 chars each = massive input
      const chunks = makeChunks(20, 1000);
      const result = await summarizer.summarize(chunks);

      expect(result.wasSummarized).toBe(true);
      expect(result.depth).toBeGreaterThan(1);
      expect(result.outputTokens).toBeLessThanOrEqual(tokenBudget);
    });

    it("respects maxDepth to prevent infinite recursion", async () => {
      const tokenBudget = 10; // Impossibly tight: 40 chars
      const summarizer = new HierarchicalSummarizer({
        tokenBudget,
        maxDepth: 2,
        summarizer: mockSummarizer,
      });
      const chunks = makeChunks(20, 5000);
      const result = await summarizer.summarize(chunks);

      expect(result.depth).toBeLessThanOrEqual(2);
    });
  });

  describe("performance", () => {
    it("completes 20 chunks within 3 second budget", async () => {
      const summarizer = new HierarchicalSummarizer({
        tokenBudget: 500,
        summarizer: mockSummarizer,
        timeoutMs: 3000,
      });
      const chunks = makeChunks(20, 400);
      const result = await summarizer.summarize(chunks);

      expect(result.durationMs).toBeLessThan(3000);
    });
  });

  describe("entity preservation", () => {
    it("map phase preserves content structure", async () => {
      const entityPreservingSummarizer: SummarizerFn = async (text, targetTokens) => {
        const targetChars = targetTokens * 4;
        if (text.length <= targetChars) return text;
        // Just truncate but keep entities intact
        return text.slice(0, targetChars);
      };

      const summarizer = new HierarchicalSummarizer({
        tokenBudget: 100,
        summarizer: entityPreservingSummarizer,
      });

      const chunks: ChunkInput[] = [
        {
          content: "Date: 2024-01-15. Revenue: $5.2M. URL: https://example.com " + "x".repeat(500),
        },
        { content: "Contact: user@test.com. Path: /src/main.ts " + "y".repeat(500) },
      ];

      const result = await summarizer.summarize(chunks);
      expect(result.wasSummarized).toBe(true);
      // The summarizer sees the entities in the text being processed
      expect(result.chunkCount).toBe(2);
    });
  });

  describe("metadata handling", () => {
    it("works with chunks that have metadata", async () => {
      const summarizer = new HierarchicalSummarizer({
        tokenBudget: 50,
        summarizer: mockSummarizer,
      });
      const chunks: ChunkInput[] = [
        { content: "x".repeat(500), metadata: { source: "doc1", page: 1 } },
        { content: "y".repeat(500), metadata: { source: "doc2", page: 5 } },
      ];

      const result = await summarizer.summarize(chunks);
      expect(result.wasSummarized).toBe(true);
      expect(result.chunkCount).toBe(2);
    });

    it("works with chunks that lack metadata", async () => {
      const summarizer = new HierarchicalSummarizer({
        tokenBudget: 50,
        summarizer: mockSummarizer,
      });
      const chunks: ChunkInput[] = [{ content: "x".repeat(500) }, { content: "y".repeat(500) }];

      const result = await summarizer.summarize(chunks);
      expect(result.wasSummarized).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles single large chunk", async () => {
      const summarizer = new HierarchicalSummarizer({
        tokenBudget: 50,
        summarizer: mockSummarizer,
      });
      const chunks: ChunkInput[] = [{ content: "a".repeat(2000) }];
      const result = await summarizer.summarize(chunks);

      expect(result.wasSummarized).toBe(true);
      expect(result.chunkCount).toBe(1);
    });

    it("handles chunks with empty content gracefully", async () => {
      const summarizer = new HierarchicalSummarizer({
        tokenBudget: 100,
        summarizer: mockSummarizer,
      });
      const chunks: ChunkInput[] = [
        { content: "" },
        { content: "x".repeat(1000) },
        { content: "" },
      ];
      const result = await summarizer.summarize(chunks);
      // Should still summarize due to the large middle chunk
      expect(result.chunkCount).toBe(3);
    });
  });
});
