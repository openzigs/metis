/**
 * Epic #515 / Issue #518 — Unit tests for ProgressiveResultManager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ProgressiveResultManager,
  estimateTokens,
  getThresholdFromEnv,
} from "./progressive-results.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates at ~4 chars per token", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("hello world!")).toBe(3); // 12/4 = 3
  });
});

describe("getThresholdFromEnv", () => {
  afterEach(() => {
    delete process.env.TOOL_RESULT_SUMMARY_THRESHOLD;
  });

  it("returns default (500) when env is not set", () => {
    delete process.env.TOOL_RESULT_SUMMARY_THRESHOLD;
    expect(getThresholdFromEnv()).toBe(500);
  });

  it("reads from TOOL_RESULT_SUMMARY_THRESHOLD env", () => {
    process.env.TOOL_RESULT_SUMMARY_THRESHOLD = "1000";
    expect(getThresholdFromEnv()).toBe(1000);
  });

  it("returns default for invalid values", () => {
    process.env.TOOL_RESULT_SUMMARY_THRESHOLD = "not-a-number";
    expect(getThresholdFromEnv()).toBe(500);
  });

  it("returns default for zero", () => {
    process.env.TOOL_RESULT_SUMMARY_THRESHOLD = "0";
    expect(getThresholdFromEnv()).toBe(500);
  });

  it("returns default for negative values", () => {
    process.env.TOOL_RESULT_SUMMARY_THRESHOLD = "-100";
    expect(getThresholdFromEnv()).toBe(500);
  });
});

describe("ProgressiveResultManager", () => {
  let manager: ProgressiveResultManager;

  beforeEach(() => {
    manager = new ProgressiveResultManager({
      thresholdTokens: 50, // 200 chars threshold for testing
      ttlMs: 5000,
      summaryMaxTokens: 100,
    });
  });

  describe("processResult — below threshold", () => {
    it("returns content verbatim when under threshold", () => {
      const content = "Short result";
      const result = manager.processResult("test_tool", content);

      expect(result.wasSummarized).toBe(false);
      expect(result.content).toBe(content);
      expect(result.cacheId).toBeUndefined();
      expect(result.originalTokens).toBe(estimateTokens(content));
      expect(result.outputTokens).toBe(estimateTokens(content));
    });

    it("does not cache small results", () => {
      manager.processResult("test_tool", "small");
      expect(manager.cacheSize).toBe(0);
    });
  });

  describe("processResult — above threshold", () => {
    it("summarizes content above threshold", () => {
      const content = "x".repeat(500); // 125 tokens > 50 threshold
      const result = manager.processResult("test_tool", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.cacheId).toBeDefined();
      expect(result.outputTokens).toBeLessThan(result.originalTokens);
    });

    it("caches the full result", () => {
      const content = "y".repeat(500);
      const result = manager.processResult("big_tool", content);

      expect(manager.cacheSize).toBe(1);
      const full = manager.getFullResult(result.cacheId!);
      expect(full).toBe(content);
    });

    it("summary includes tool name and token count", () => {
      const content = "z".repeat(500);
      const result = manager.processResult("my_tool", content);

      expect(result.content).toContain("my_tool");
      expect(result.content).toContain("125 tokens");
    });

    it("summary includes get_full_result instruction", () => {
      const content = "a".repeat(500);
      const result = manager.processResult("tool_x", content);

      expect(result.content).toContain("get_full_result");
      expect(result.content).toContain(result.cacheId!);
    });

    it("summary includes result count for JSON arrays", () => {
      const items = Array.from({ length: 25 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
        description: "A".repeat(50),
      }));
      const content = JSON.stringify(items);
      const result = manager.processResult("list_tool", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.content).toContain("25 items");
    });

    it("summary includes key fields for JSON objects", () => {
      const content = JSON.stringify({
        id: "pr-456",
        title: "Fix authentication",
        status: "open",
        body: "B".repeat(1000),
      });
      const result = manager.processResult("get_pr", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.content).toContain("pr-456");
      expect(result.content).toContain("Fix authentication");
    });

    it("summary includes preview for non-JSON content", () => {
      const content = "Error: Something failed\n" + "x".repeat(500);
      const result = manager.processResult("run_cmd", content);

      expect(result.wasSummarized).toBe(true);
      expect(result.content).toContain("Error: Something failed");
    });
  });

  describe("getFullResult", () => {
    it("returns null for unknown cache ID", () => {
      expect(manager.getFullResult("nonexistent-id")).toBeNull();
    });

    it("returns cached content", () => {
      const content = "w".repeat(500);
      const result = manager.processResult("tool_a", content);
      const full = manager.getFullResult(result.cacheId!);
      expect(full).toBe(content);
    });

    it("returns null for expired entries", () => {
      // Use a very short TTL
      const shortTtlManager = new ProgressiveResultManager({
        thresholdTokens: 10,
        ttlMs: 1, // 1ms TTL
      });
      const content = "q".repeat(500);
      const result = shortTtlManager.processResult("tool_b", content);

      // Wait a bit to ensure expiry
      vi.useFakeTimers();
      vi.advanceTimersByTime(10);
      const full = shortTtlManager.getFullResult(result.cacheId!);
      expect(full).toBeNull();
      vi.useRealTimers();
    });
  });

  describe("evictExpired", () => {
    it("removes expired entries", () => {
      vi.useFakeTimers();
      const shortManager = new ProgressiveResultManager({
        thresholdTokens: 10,
        ttlMs: 100,
      });

      shortManager.processResult("tool1", "a".repeat(200));
      shortManager.processResult("tool2", "b".repeat(200));
      expect(shortManager.cacheSize).toBe(2);

      vi.advanceTimersByTime(200);
      const evicted = shortManager.evictExpired();
      expect(evicted).toBe(2);
      expect(shortManager.cacheSize).toBe(0);
      vi.useRealTimers();
    });

    it("keeps non-expired entries", () => {
      vi.useFakeTimers();
      const shortManager = new ProgressiveResultManager({
        thresholdTokens: 10,
        ttlMs: 1000,
      });

      shortManager.processResult("tool1", "a".repeat(200));
      vi.advanceTimersByTime(500); // Half TTL
      shortManager.processResult("tool2", "b".repeat(200));

      vi.advanceTimersByTime(600); // First entry expired (1100ms), second not (600ms)
      const evicted = shortManager.evictExpired();
      expect(evicted).toBe(1);
      expect(shortManager.cacheSize).toBe(1);
      vi.useRealTimers();
    });

    it("returns 0 when nothing to evict", () => {
      expect(manager.evictExpired()).toBe(0);
    });
  });

  describe("clearCache", () => {
    it("removes all entries", () => {
      manager.processResult("tool1", "x".repeat(500));
      manager.processResult("tool2", "y".repeat(500));
      expect(manager.cacheSize).toBe(2);

      manager.clearCache();
      expect(manager.cacheSize).toBe(0);
    });
  });

  describe("buildSystemInstruction", () => {
    it("returns instruction text about progressive disclosure", () => {
      const instruction = ProgressiveResultManager.buildSystemInstruction();
      expect(instruction).toContain("Progressive Tool Results");
      expect(instruction).toContain("get_full_result");
      expect(instruction).toContain("summarized");
    });
  });

  describe("multiple results", () => {
    it("caches multiple results independently", () => {
      const r1 = manager.processResult("tool1", "a".repeat(500));
      const r2 = manager.processResult("tool2", "b".repeat(500));

      expect(r1.cacheId).not.toBe(r2.cacheId);
      expect(manager.getFullResult(r1.cacheId!)).toBe("a".repeat(500));
      expect(manager.getFullResult(r2.cacheId!)).toBe("b".repeat(500));
    });
  });

  describe("threshold boundary", () => {
    it("exactly at threshold is not summarized", () => {
      // 50 tokens = 200 chars exactly
      const content = "x".repeat(200);
      const result = manager.processResult("tool", content);
      expect(result.wasSummarized).toBe(false);
    });

    it("one token over threshold is summarized", () => {
      // 51 tokens = 204 chars
      const content = "x".repeat(204);
      const result = manager.processResult("tool", content);
      expect(result.wasSummarized).toBe(true);
    });
  });
});
