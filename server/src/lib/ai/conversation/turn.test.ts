/**
 * PR #205 review — which replies are calibration samples (#137).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({ prisma: {} }));
const { calibrationPromptChars, nativeToolChars, titleFromQuestion } = await import("./turn.js");

describe("calibrationPromptChars", () => {
  it("keeps the prompt size of a single-call turn as a sample", () => {
    expect(calibrationPromptChars({ promptChars: 1_234 }, [])).toBe(1_234);
  });

  it("drops a code-tool turn, whose usage sums several calls against one prompt", () => {
    expect(calibrationPromptChars({ promptChars: 1_234 }, [{ tool: "search_code_graph" }])).toBe(
      null,
    );
  });
});

describe("nativeToolChars (#137)", () => {
  it("counts the natively-sent tool specs as serialised, and nothing for none", () => {
    const specs = [
      { name: "search_code", description: "Search.", parameters: { type: "object" as const } },
    ];
    expect(nativeToolChars(specs)).toBe(JSON.stringify(specs).length);
    expect(nativeToolChars([])).toBe(0);
    expect(nativeToolChars(undefined)).toBe(0);
  });
});

describe("titleFromQuestion (#980)", () => {
  it("collapses whitespace and keeps a short question whole", () => {
    expect(titleFromQuestion("  What   is\n this?  ")).toBe("What is this?");
  });

  it("returns null for a question with no visible text", () => {
    expect(titleFromQuestion(" \n\t ")).toBeNull();
  });

  it("cuts a long question at a word boundary, within 80 characters, with an ellipsis", () => {
    const t = titleFromQuestion("abcdefghij ".repeat(10))!;
    expect(t.length).toBeLessThanOrEqual(80);
    // Seven whole words: the eighth, cut mid-word at 79 characters, is dropped.
    expect(t).toBe(`${Array(7).fill("abcdefghij").join(" ")}…`);
  });

  it("cuts mid-word when the question has no space late enough to break on", () => {
    const t = titleFromQuestion("x".repeat(200))!;
    expect(t).toBe(`${"x".repeat(79)}…`);
  });
});
