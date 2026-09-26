/**
 * PR #205 review — which replies are calibration samples (#137).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({ prisma: {} }));
const { calibrationPromptChars } = await import("./turn.js");

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
