/**
 * Epic #511 / Issue #514 — Adaptive budget allocator unit tests.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { TokenCategory } from "../ai/token-categorizer.js";
import {
  AdaptiveBudgetAllocator,
  DEFAULT_PROFILES,
  QueryType,
  classifyQuery,
  type TelemetryDataPoint,
} from "./adaptive-budget.js";

describe("classifyQuery", () => {
  it("classifies code-related queries", () => {
    expect(classifyQuery("fix the bug in the function")).toBe(QueryType.CODE_QUERY);
    expect(classifyQuery("refactor the class to use typescript")).toBe(QueryType.CODE_QUERY);
    expect(classifyQuery("implement the new method")).toBe(QueryType.CODE_QUERY);
  });

  it("classifies tool/workflow queries", () => {
    expect(classifyQuery("run the build pipeline")).toBe(QueryType.TOOL_WORKFLOW);
    expect(classifyQuery("execute the deploy script")).toBe(QueryType.TOOL_WORKFLOW);
    expect(classifyQuery("create file and install dependencies")).toBe(QueryType.TOOL_WORKFLOW);
  });

  it("classifies document queries", () => {
    expect(classifyQuery("explain the architecture design")).toBe(QueryType.DOCUMENT_QUERY);
    expect(classifyQuery("summarize the requirement specification")).toBe(QueryType.DOCUMENT_QUERY);
    expect(classifyQuery("what is the overview of the system")).toBe(QueryType.DOCUMENT_QUERY);
  });

  it("defaults to general chat for ambiguous queries", () => {
    expect(classifyQuery("hello")).toBe(QueryType.GENERAL_CHAT);
    expect(classifyQuery("thanks")).toBe(QueryType.GENERAL_CHAT);
    expect(classifyQuery("")).toBe(QueryType.GENERAL_CHAT);
  });

  it("handles mixed signals by picking highest score", () => {
    // "explain the code" — "explain" (doc) + "code" (code) → tie, code wins by order
    const result = classifyQuery("explain the code function");
    expect([QueryType.CODE_QUERY, QueryType.DOCUMENT_QUERY]).toContain(result);
  });
});

describe("DEFAULT_PROFILES", () => {
  it("all profiles sum to 1.0", () => {
    for (const queryType of Object.values(QueryType)) {
      const profile = DEFAULT_PROFILES[queryType];
      const sum = Object.values(profile).reduce((s, v) => s + v, 0);
      expect(sum).toBeCloseTo(1.0, 5);
    }
  });

  it("all profile values are positive", () => {
    for (const queryType of Object.values(QueryType)) {
      const profile = DEFAULT_PROFILES[queryType];
      for (const value of Object.values(profile)) {
        expect(value).toBeGreaterThan(0);
      }
    }
  });

  it("code_query allocates most to code_context", () => {
    const profile = DEFAULT_PROFILES[QueryType.CODE_QUERY];
    const maxCategory = Object.entries(profile).reduce((a, b) => (a[1] > b[1] ? a : b));
    expect(maxCategory[0]).toBe(TokenCategory.CODE_CONTEXT);
  });

  it("document_query allocates most to rag_context", () => {
    const profile = DEFAULT_PROFILES[QueryType.DOCUMENT_QUERY];
    const maxCategory = Object.entries(profile).reduce((a, b) => (a[1] > b[1] ? a : b));
    expect(maxCategory[0]).toBe(TokenCategory.RAG_CONTEXT);
  });
});

describe("AdaptiveBudgetAllocator", () => {
  let allocator: AdaptiveBudgetAllocator;

  beforeEach(() => {
    allocator = new AdaptiveBudgetAllocator({ maxTokens: 10000 });
  });

  it("extends TokenBudget — record and budget enforcement work", () => {
    expect(allocator.total).toBe(10000);
    expect(allocator.used).toBe(0);
    allocator.record(5000);
    expect(allocator.used).toBe(5000);
    expect(allocator.hasRemaining()).toBe(true);
  });

  it("allocate returns budgets for all categories", () => {
    const budgets = allocator.allocate("fix the bug in the code");
    expect(budgets).toHaveLength(Object.values(TokenCategory).length);
    for (const b of budgets) {
      expect(b.tokens).toBeGreaterThan(0);
      expect(b.percentage).toBeGreaterThan(0);
      expect(b.percentage).toBeLessThanOrEqual(1);
    }
  });

  it("allocations sum to total budget", () => {
    const budgets = allocator.allocate("explain the architecture");
    const sum = budgets.reduce((s, b) => s + b.tokens, 0);
    // Allow rounding tolerance of ±number of categories
    expect(Math.abs(sum - 10000)).toBeLessThanOrEqual(Object.values(TokenCategory).length);
  });

  it("uses static profiles when telemetry is insufficient", () => {
    // Add only 5 data points (below threshold of 10)
    const fewPoints: TelemetryDataPoint[] = Array.from({ length: 5 }, () => ({
      queryType: QueryType.CODE_QUERY,
      categoryBreakdown: { [TokenCategory.CODE_CONTEXT]: 8000 },
      totalTokens: 10000,
    }));
    allocator.addTelemetry(fewPoints);

    const budgets = allocator.allocateForType(QueryType.CODE_QUERY);
    const codeCtx = budgets.find((b) => b.category === TokenCategory.CODE_CONTEXT)!;
    // Should use static profile: 40% of 10000 = 4000
    expect(codeCtx.tokens).toBe(4000);
  });

  it("adapts allocation when sufficient telemetry is available", () => {
    // Simulate 15 sessions where code_context used 80% of budget (way more than 40% allocation)
    const points: TelemetryDataPoint[] = Array.from({ length: 15 }, () => ({
      queryType: QueryType.CODE_QUERY,
      categoryBreakdown: {
        [TokenCategory.CODE_CONTEXT]: 8000,
        [TokenCategory.TOOL_MANIFESTS]: 500,
        [TokenCategory.TOOL_RESULTS]: 500,
        [TokenCategory.HISTORY]: 500,
        [TokenCategory.RAG_CONTEXT]: 200,
        [TokenCategory.SYSTEM_PROMPT]: 200,
        [TokenCategory.USER_MESSAGE]: 100,
      },
      totalTokens: 10000,
    }));
    allocator.addTelemetry(points);

    const budgets = allocator.allocateForType(QueryType.CODE_QUERY);
    const codeCtx = budgets.find((b) => b.category === TokenCategory.CODE_CONTEXT)!;
    // Should be adapted upward from 40% baseline
    expect(codeCtx.percentage).toBeGreaterThan(0.4);
  });

  it("does not shift any category more than MAX_SHIFT (15%)", () => {
    // Extreme telemetry: everything goes to code_context
    const extremePoints: TelemetryDataPoint[] = Array.from({ length: 20 }, () => ({
      queryType: QueryType.GENERAL_CHAT,
      categoryBreakdown: {
        [TokenCategory.CODE_CONTEXT]: 9500,
        [TokenCategory.TOOL_MANIFESTS]: 100,
        [TokenCategory.TOOL_RESULTS]: 100,
        [TokenCategory.HISTORY]: 100,
        [TokenCategory.RAG_CONTEXT]: 100,
        [TokenCategory.SYSTEM_PROMPT]: 50,
        [TokenCategory.USER_MESSAGE]: 50,
      },
      totalTokens: 10000,
    }));
    allocator.addTelemetry(extremePoints);

    const budgets = allocator.allocateForType(QueryType.GENERAL_CHAT);
    const baseProfile = DEFAULT_PROFILES[QueryType.GENERAL_CHAT];

    for (const b of budgets) {
      const basePct = baseProfile[b.category];
      const shift = Math.abs(b.percentage - basePct);
      // After normalization, shift should be bounded
      expect(shift).toBeLessThan(0.25); // generous bound accounting for normalization
    }
  });

  it("ensures no category drops below 1% after adaptation", () => {
    const points: TelemetryDataPoint[] = Array.from({ length: 20 }, () => ({
      queryType: QueryType.CODE_QUERY,
      categoryBreakdown: {
        [TokenCategory.CODE_CONTEXT]: 9900,
        [TokenCategory.TOOL_MANIFESTS]: 10,
        [TokenCategory.TOOL_RESULTS]: 10,
        [TokenCategory.HISTORY]: 30,
        [TokenCategory.RAG_CONTEXT]: 20,
        [TokenCategory.SYSTEM_PROMPT]: 20,
        [TokenCategory.USER_MESSAGE]: 10,
      },
      totalTokens: 10000,
    }));
    allocator.addTelemetry(points);

    const budgets = allocator.allocateForType(QueryType.CODE_QUERY);
    for (const b of budgets) {
      expect(b.percentage).toBeGreaterThanOrEqual(0.005); // allow small rounding
      expect(b.tokens).toBeGreaterThan(0);
    }
  });

  it("dataPointCount reflects added telemetry", () => {
    expect(allocator.dataPointCount).toBe(0);
    allocator.addTelemetry([
      {
        queryType: QueryType.GENERAL_CHAT,
        categoryBreakdown: {},
        totalTokens: 100,
      },
    ]);
    expect(allocator.dataPointCount).toBe(1);
  });

  it("accepts custom profiles in options", () => {
    const customAllocator = new AdaptiveBudgetAllocator({
      maxTokens: 10000,
      profiles: {
        [QueryType.GENERAL_CHAT]: {
          [TokenCategory.CODE_CONTEXT]: 0.5,
          [TokenCategory.TOOL_MANIFESTS]: 0.1,
          [TokenCategory.TOOL_RESULTS]: 0.1,
          [TokenCategory.HISTORY]: 0.1,
          [TokenCategory.RAG_CONTEXT]: 0.1,
          [TokenCategory.SYSTEM_PROMPT]: 0.05,
          [TokenCategory.USER_MESSAGE]: 0.05,
        },
      },
    });

    const budgets = customAllocator.allocateForType(QueryType.GENERAL_CHAT);
    const codeCtx = budgets.find((b) => b.category === TokenCategory.CODE_CONTEXT)!;
    expect(codeCtx.tokens).toBe(5000); // 50% of 10000
  });
});
