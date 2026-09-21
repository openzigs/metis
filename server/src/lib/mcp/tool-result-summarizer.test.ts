/**
 * Epic #502 / Issue #505 — Unit tests for ToolResultSummarizer.
 */
import { describe, it, expect } from "vitest";
import { ToolResultSummarizer, estimateTokens } from "./tool-result-summarizer.js";

describe("ToolResultSummarizer", () => {
  describe("estimateTokens", () => {
    it("estimates tokens at 4 chars per token", () => {
      expect(estimateTokens("abcd")).toBe(1);
      expect(estimateTokens("hello world")).toBe(3); // 11/4 = 2.75 → 3
      expect(estimateTokens("")).toBe(0);
    });
  });

  describe("summarize", () => {
    it("does not summarize content below threshold", () => {
      const summarizer = new ToolResultSummarizer({ thresholdTokens: 100 });
      const shortContent = "This is a short result";

      const result = summarizer.summarize("test_tool", shortContent);

      expect(result.wasSummarized).toBe(false);
      expect(result.content).toBe(shortContent);
      expect(result.originalTokens).toBe(estimateTokens(shortContent));
    });

    it("summarizes JSON arrays above threshold", () => {
      const summarizer = new ToolResultSummarizer({ thresholdTokens: 10 });
      const items = Array.from({ length: 50 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
        description: "A".repeat(100),
        metadata: { created: "2024-01-01" },
      }));
      const content = JSON.stringify(items);

      const result = summarizer.summarize("test_tool", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.content).toContain("[Summarized from");
      expect(result.content).toContain("Array with 50 items");
      expect(result.content).toContain("item-0");
      expect(result.summarizedTokens).toBeLessThan(result.originalTokens);
    });

    it("summarizes JSON objects preserving key fields", () => {
      const summarizer = new ToolResultSummarizer({ thresholdTokens: 10 });
      const content = JSON.stringify({
        id: "pr-123",
        url: "https://github.com/org/repo/pull/123",
        title: "Fix authentication bug",
        status: "open",
        body: "A".repeat(5000),
        diff: "B".repeat(5000),
        comments: Array.from({ length: 100 }, () => ({ text: "comment" })),
      });

      const result = summarizer.summarize("test_tool", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.content).toContain("pr-123");
      expect(result.content).toContain("https://github.com/org/repo/pull/123");
      expect(result.content).toContain("Fix authentication bug");
      expect(result.content).toContain("open");
    });

    it("preserves error messages", () => {
      const summarizer = new ToolResultSummarizer({ thresholdTokens: 10 });
      const content = JSON.stringify({
        error: "Connection timeout",
        message: "Failed to connect to database",
        stack: "A".repeat(3000),
        details: { host: "localhost", port: 5432 },
      });

      const result = summarizer.summarize("test_tool", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.content).toContain("Connection timeout");
      expect(result.content).toContain("Failed to connect to database");
    });

    it("handles non-JSON content with text summarization", () => {
      const summarizer = new ToolResultSummarizer({ thresholdTokens: 10 });
      const content = "Error: Something went wrong\nhttps://example.com/error\n" + "X".repeat(5000);

      const result = summarizer.summarize("test_tool", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.content).toContain("[Summarized from");
      expect(result.content).toContain("https://example.com/error");
    });

    it("uses per-tool rules for field preservation", () => {
      const summarizer = new ToolResultSummarizer({
        thresholdTokens: 10,
        toolRules: {
          github_pr: ["author", "mergeable", "labels"],
        },
      });
      const content = JSON.stringify({
        id: "pr-1",
        author: "octocat",
        mergeable: true,
        labels: ["bug", "priority"],
        diff: "C".repeat(5000),
        reviews: Array.from({ length: 50 }, () => ({ body: "lgtm" })),
      });

      const result = summarizer.summarize("github_pr", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.content).toContain("octocat");
      expect(result.content).toContain("mergeable");
    });

    it("prefixes summarized content with token marker", () => {
      const summarizer = new ToolResultSummarizer({ thresholdTokens: 10 });
      const content = JSON.stringify({ data: "X".repeat(500) });

      const result = summarizer.summarize("test_tool", content);

      expect(result.content).toMatch(/^\[Summarized from \d+ tokens\]/);
    });

    it("respects maxOutputTokens", () => {
      const summarizer = new ToolResultSummarizer({
        thresholdTokens: 10,
        maxOutputTokens: 20,
      });
      const content = "Y".repeat(50000);

      const result = summarizer.summarize("test_tool", content);

      // Max output tokens = 20, so max chars ≈ 80 + prefix
      expect(result.summarizedTokens).toBeLessThanOrEqual(50);
    });

    it("handles empty content", () => {
      const summarizer = new ToolResultSummarizer({ thresholdTokens: 100 });
      const result = summarizer.summarize("test_tool", "");

      expect(result.wasSummarized).toBe(false);
      expect(result.content).toBe("");
    });

    it("handles null/undefined-like JSON values", () => {
      const summarizer = new ToolResultSummarizer({ thresholdTokens: 10 });
      const content = JSON.stringify(null);

      // null is below threshold typically, but even if forced, should handle gracefully
      const result = summarizer.summarize("test_tool", content);
      expect(result.content).toBeDefined();
    });
  });
});
