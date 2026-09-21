/**
 * Epic #593 / Issue #603 — Task Profiler unit tests.
 */
import { describe, expect, it } from "vitest";
import { TaskProfiler } from "../src/lib/ai/task-profiler.js";

describe("TaskProfiler", () => {
  const profiler = new TaskProfiler();

  describe("classify", () => {
    it("returns a complete TaskProfile", () => {
      const profile = profiler.classify("Summarize this document");
      expect(profile).toHaveProperty("tokenEstimate");
      expect(profile).toHaveProperty("reasoningDepth");
      expect(profile).toHaveProperty("latencySLA");
      expect(profile).toHaveProperty("taskType");
    });

    it("classifies short summarization as simple/interactive", () => {
      const profile = profiler.classify("Summarize this short text");
      expect(profile.taskType).toBe("summarization");
      expect(profile.reasoningDepth).toBe("simple");
      expect(profile.latencySLA).toBe("interactive");
    });

    it("classifies synthesis keywords as complex", () => {
      const profile = profiler.classify(
        "Synthesize findings from multiple sources and evaluate trade-offs",
      );
      expect(profile.taskType).toBe("synthesis");
      expect(profile.reasoningDepth).toBe("complex");
    });

    it("classifies cross-referencing as complex", () => {
      const profile = profiler.classify("Cross-reference the API specs with the database schema");
      expect(profile.reasoningDepth).toBe("complex");
    });
  });

  describe("classifyTaskType", () => {
    it("maps document agent to extraction", () => {
      expect(profiler.classifyTaskType("anything", "document")).toBe("extraction");
    });

    it("maps web agent to cross-referencing", () => {
      expect(profiler.classifyTaskType("anything", "web")).toBe("cross-referencing");
    });

    it("maps database agent to analysis", () => {
      expect(profiler.classifyTaskType("anything", "database")).toBe("analysis");
    });

    it("maps code agent to analysis", () => {
      expect(profiler.classifyTaskType("anything", "code")).toBe("analysis");
    });

    it("maps synthesis agent to synthesis", () => {
      expect(profiler.classifyTaskType("anything", "synthesis")).toBe("synthesis");
    });

    it("detects complex keywords in content", () => {
      expect(profiler.classifyTaskType("evaluate the implications")).toBe("synthesis");
      expect(profiler.classifyTaskType("recommend an architecture")).toBe("synthesis");
    });

    it("detects simple keywords in content", () => {
      expect(profiler.classifyTaskType("extract the key entities")).toBe("summarization");
      expect(profiler.classifyTaskType("list all the findings")).toBe("summarization");
    });

    it("defaults short prompts to general", () => {
      expect(profiler.classifyTaskType("hello")).toBe("general");
    });

    it("defaults longer prompts without keywords to analysis", () => {
      const long = "a".repeat(300);
      expect(profiler.classifyTaskType(long)).toBe("analysis");
    });
  });

  describe("classifyReasoningDepth", () => {
    it("returns simple for summarization", () => {
      expect(profiler.classifyReasoningDepth("short text", "summarization")).toBe("simple");
    });

    it("returns simple for extraction", () => {
      expect(profiler.classifyReasoningDepth("short text", "extraction")).toBe("simple");
    });

    it("returns complex for synthesis", () => {
      expect(profiler.classifyReasoningDepth("anything", "synthesis")).toBe("complex");
    });

    it("returns complex for cross-referencing", () => {
      expect(profiler.classifyReasoningDepth("anything", "cross-referencing")).toBe("complex");
    });

    it("returns moderate for code agent doing analysis", () => {
      expect(profiler.classifyReasoningDepth("code", "analysis", "code")).toBe("moderate");
    });

    it("returns moderate for database agent doing analysis", () => {
      expect(profiler.classifyReasoningDepth("db", "analysis", "database")).toBe("moderate");
    });

    it("returns complex for very long content in analysis", () => {
      const long = "x".repeat(15_000);
      expect(profiler.classifyReasoningDepth(long, "analysis")).toBe("complex");
    });

    it("returns moderate for medium-length content in analysis", () => {
      const medium = "x".repeat(5_000);
      expect(profiler.classifyReasoningDepth(medium, "analysis")).toBe("moderate");
    });

    it("returns simple for short content in analysis without agent hint", () => {
      expect(profiler.classifyReasoningDepth("short", "analysis")).toBe("simple");
    });
  });

  describe("estimateTokens", () => {
    it("estimates tokens based on input length and output multiplier", () => {
      // 100 chars / 4 = 25 input tokens
      // summarization multiplier = 0.3 => 8 output tokens
      // total = 33
      const text = "x".repeat(100);
      expect(profiler.estimateTokens(text, "summarization")).toBe(33);
    });

    it("uses higher multiplier for synthesis", () => {
      const text = "x".repeat(100);
      const sumTokens = profiler.estimateTokens(text, "summarization");
      const synTokens = profiler.estimateTokens(text, "synthesis");
      expect(synTokens).toBeGreaterThan(sumTokens);
    });

    it("returns 0 for empty content", () => {
      expect(profiler.estimateTokens("", "general")).toBe(0);
    });
  });

  describe("classifyLatencySLA", () => {
    it("returns interactive for simple + low tokens", () => {
      expect(profiler.classifyLatencySLA("simple", 500)).toBe("interactive");
    });

    it("returns standard for simple + high tokens", () => {
      expect(profiler.classifyLatencySLA("simple", 5_000)).toBe("standard");
    });

    it("returns background for complex reasoning", () => {
      expect(profiler.classifyLatencySLA("complex", 1_000)).toBe("background");
    });

    it("returns background for very high token estimates", () => {
      expect(profiler.classifyLatencySLA("moderate", 25_000)).toBe("background");
    });

    it("returns standard for moderate + reasonable tokens", () => {
      expect(profiler.classifyLatencySLA("moderate", 5_000)).toBe("standard");
    });
  });
});
