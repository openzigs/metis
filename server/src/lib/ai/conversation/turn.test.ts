/**
 * PR #205 review — which replies are calibration samples (#137).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({ prisma: {} }));
const { calibrationPromptChars, nativeToolChars } = await import("./turn.js");

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
