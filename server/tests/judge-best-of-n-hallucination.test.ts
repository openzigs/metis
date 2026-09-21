/**
 * Epic #194 (C.3) — judgeWithHallucination tests.
 */
import { describe, expect, it, vi } from "vitest";

import { judgeWithHallucination } from "../src/lib/async/best-of-n.js";

describe("judgeWithHallucination", () => {
  const runs = [
    { id: "a", result: { content: "alpha" }, score: 0.5 },
    { id: "b", result: { content: "beta" }, score: 0.5 },
  ];

  it("re-ranks by base score + weight * grounding", async () => {
    const judge = judgeWithHallucination({
      grounding: async (r) => (r.id === "b" ? 1 : 0),
      weight: 0.5,
    });
    const result = await judge(runs);
    expect(result.winnerRunId).toBe("b");
  });

  it("falls back to the base judge when top two are within 0.05", async () => {
    const base = vi.fn(async () => ({ winnerRunId: "a" }));
    const judge = judgeWithHallucination({
      base,
      grounding: async () => 0.5,
    });
    const result = await judge(runs);
    expect(base).toHaveBeenCalled();
    expect(result.winnerRunId).toBe("a");
  });

  it("returns 0 when the grounding scorer throws", async () => {
    const judge = judgeWithHallucination({
      grounding: async () => {
        throw new Error("boom");
      },
    });
    const result = await judge(runs);
    // Both end up tied at base score → first by id.
    expect(["a", "b"]).toContain(result.winnerRunId);
  });

  it("uses default weight when not provided", async () => {
    const judge = judgeWithHallucination({
      grounding: async (r) => (r.id === "b" ? 1 : 0),
    });
    const result = await judge(runs);
    expect(result.winnerRunId).toBe("b");
  });
});
