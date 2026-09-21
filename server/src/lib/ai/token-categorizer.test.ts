/**
 * Epic #511 / Issue #512 — Token categorizer unit tests.
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  TokenCategory,
  TokenCategorizer,
  computeCategoryBreakdown,
  estimateTokens,
  totalFromBreakdown,
  type CategoryBreakdown,
  type PromptSection,
} from "./token-categorizer.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns 0 for null-ish input", () => {
    expect(estimateTokens(null as unknown as string)).toBe(0);
    expect(estimateTokens(undefined as unknown as string)).toBe(0);
  });

  it("estimates ~1 token per 4 characters", () => {
    // 20 chars → 5 tokens
    expect(estimateTokens("Hello world! How are")).toBe(5);
  });

  it("rounds up partial tokens", () => {
    // 5 chars → ceil(5/4) = 2
    expect(estimateTokens("Hello")).toBe(2);
  });

  it("handles long strings", () => {
    const text = "a".repeat(1000);
    expect(estimateTokens(text)).toBe(250);
  });
});

describe("computeCategoryBreakdown", () => {
  it("returns empty object for empty sections", () => {
    expect(computeCategoryBreakdown([])).toEqual({});
  });

  it("computes breakdown for single section", () => {
    const sections: PromptSection[] = [
      { category: TokenCategory.SYSTEM_PROMPT, content: "You are an assistant" },
    ];
    const result = computeCategoryBreakdown(sections);
    expect(result[TokenCategory.SYSTEM_PROMPT]).toBe(estimateTokens("You are an assistant"));
  });

  it("aggregates multiple sections of same category", () => {
    const sections: PromptSection[] = [
      { category: TokenCategory.HISTORY, content: "msg1" },
      { category: TokenCategory.HISTORY, content: "msg2msg2" },
    ];
    const result = computeCategoryBreakdown(sections);
    expect(result[TokenCategory.HISTORY]).toBe(estimateTokens("msg1") + estimateTokens("msg2msg2"));
  });

  it("tracks multiple categories independently", () => {
    const sections: PromptSection[] = [
      { category: TokenCategory.SYSTEM_PROMPT, content: "sys prompt" },
      { category: TokenCategory.USER_MESSAGE, content: "user says hi" },
      { category: TokenCategory.RAG_CONTEXT, content: "retrieved doc" },
    ];
    const result = computeCategoryBreakdown(sections);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result[TokenCategory.SYSTEM_PROMPT]).toBeGreaterThan(0);
    expect(result[TokenCategory.USER_MESSAGE]).toBeGreaterThan(0);
    expect(result[TokenCategory.RAG_CONTEXT]).toBeGreaterThan(0);
  });
});

describe("totalFromBreakdown", () => {
  it("returns 0 for empty breakdown", () => {
    expect(totalFromBreakdown({})).toBe(0);
  });

  it("sums all category values", () => {
    const breakdown: CategoryBreakdown = {
      [TokenCategory.SYSTEM_PROMPT]: 100,
      [TokenCategory.TOOL_MANIFESTS]: 200,
      [TokenCategory.USER_MESSAGE]: 50,
    };
    expect(totalFromBreakdown(breakdown)).toBe(350);
  });
});

describe("TokenCategorizer", () => {
  let categorizer: TokenCategorizer;

  beforeEach(() => {
    categorizer = new TokenCategorizer();
  });

  it("starts with zero sections", () => {
    expect(categorizer.sectionCount).toBe(0);
  });

  it("tracks added sections", () => {
    categorizer.addSection(TokenCategory.SYSTEM_PROMPT, "hello");
    categorizer.addSection(TokenCategory.USER_MESSAGE, "world");
    expect(categorizer.sectionCount).toBe(2);
  });

  it("peek returns current breakdown without resetting", () => {
    categorizer.addSection(TokenCategory.SYSTEM_PROMPT, "system");
    const peek = categorizer.peek();
    expect(peek[TokenCategory.SYSTEM_PROMPT]).toBeGreaterThan(0);
    expect(categorizer.sectionCount).toBe(1); // not reset
  });

  it("finalize returns breakdown and resets state", () => {
    categorizer.addSection(TokenCategory.SYSTEM_PROMPT, "system prompt text");
    categorizer.addSection(TokenCategory.TOOL_MANIFESTS, "tool manifest json");
    categorizer.addSection(TokenCategory.RAG_CONTEXT, "retrieved context");

    const breakdown = categorizer.finalize();

    expect(breakdown[TokenCategory.SYSTEM_PROMPT]).toBeGreaterThan(0);
    expect(breakdown[TokenCategory.TOOL_MANIFESTS]).toBeGreaterThan(0);
    expect(breakdown[TokenCategory.RAG_CONTEXT]).toBeGreaterThan(0);
    expect(categorizer.sectionCount).toBe(0); // reset after finalize
  });

  it("reset clears all sections", () => {
    categorizer.addSection(TokenCategory.HISTORY, "msg1");
    categorizer.addSection(TokenCategory.HISTORY, "msg2");
    categorizer.reset();
    expect(categorizer.sectionCount).toBe(0);
    expect(categorizer.finalize()).toEqual({});
  });

  it("handles all category types", () => {
    const categories = Object.values(TokenCategory);
    for (const cat of categories) {
      categorizer.addSection(cat, `content for ${cat}`);
    }
    const breakdown = categorizer.finalize();
    expect(Object.keys(breakdown)).toHaveLength(categories.length);
    for (const cat of categories) {
      expect(breakdown[cat]).toBeGreaterThan(0);
    }
  });

  it("multiple finalize calls yield independent results", () => {
    categorizer.addSection(TokenCategory.CODE_CONTEXT, "first batch");
    const first = categorizer.finalize();

    categorizer.addSection(TokenCategory.TOOL_RESULTS, "second batch");
    const second = categorizer.finalize();

    expect(first[TokenCategory.CODE_CONTEXT]).toBeGreaterThan(0);
    expect(first[TokenCategory.TOOL_RESULTS]).toBeUndefined();
    expect(second[TokenCategory.TOOL_RESULTS]).toBeGreaterThan(0);
    expect(second[TokenCategory.CODE_CONTEXT]).toBeUndefined();
  });
});
