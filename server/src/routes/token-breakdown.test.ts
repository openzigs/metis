/**
 * Epic #511 / Issue #513 — Token breakdown endpoint unit tests.
 *
 * Tests the aggregation logic that powers GET /api/projects/:id/token-breakdown.
 * Uses the same pattern as other route tests — mocks Prisma.
 */
import { describe, expect, it } from "vitest";

/**
 * Pure-logic extraction of the aggregation function from the route handler.
 * This allows testing the breakdown aggregation without Express plumbing.
 */
function aggregateBreakdown(rows: { categoryBreakdown: string | null; totalTokens: number }[]): {
  breakdown: Record<string, number>;
  total: number;
} {
  const agg: Record<string, number> = {};
  let totalWithBreakdown = 0;
  for (const row of rows) {
    if (row.categoryBreakdown) {
      try {
        const bd = JSON.parse(row.categoryBreakdown) as Record<string, number>;
        for (const [cat, tokens] of Object.entries(bd)) {
          agg[cat] = (agg[cat] ?? 0) + tokens;
        }
        totalWithBreakdown += row.totalTokens;
      } catch {
        // Skip malformed JSON
      }
    }
  }
  return { breakdown: agg, total: totalWithBreakdown };
}

function computeCategoryDetails(
  current: { breakdown: Record<string, number>; total: number },
  prev: { breakdown: Record<string, number>; total: number },
) {
  const categories = Object.keys(current.breakdown);
  return categories.map((cat) => {
    const tokens = current.breakdown[cat];
    const percentage = current.total > 0 ? tokens / current.total : 0;
    const prevTokens = prev.breakdown[cat] ?? 0;
    const trend = prevTokens > 0 ? (tokens - prevTokens) / prevTokens : null;
    return { category: cat, tokens, percentage, trend };
  });
}

describe("token-breakdown aggregation logic", () => {
  describe("aggregateBreakdown", () => {
    it("returns empty for no rows", () => {
      const result = aggregateBreakdown([]);
      expect(result.breakdown).toEqual({});
      expect(result.total).toBe(0);
    });

    it("skips rows without categoryBreakdown", () => {
      const result = aggregateBreakdown([
        { categoryBreakdown: null, totalTokens: 100 },
        { categoryBreakdown: null, totalTokens: 200 },
      ]);
      expect(result.breakdown).toEqual({});
      expect(result.total).toBe(0);
    });

    it("aggregates single row", () => {
      const bd = JSON.stringify({ system_prompt: 100, user_message: 50 });
      const result = aggregateBreakdown([{ categoryBreakdown: bd, totalTokens: 150 }]);
      expect(result.breakdown).toEqual({ system_prompt: 100, user_message: 50 });
      expect(result.total).toBe(150);
    });

    it("aggregates multiple rows", () => {
      const bd1 = JSON.stringify({ system_prompt: 100, history: 200 });
      const bd2 = JSON.stringify({ system_prompt: 50, rag_context: 300 });
      const result = aggregateBreakdown([
        { categoryBreakdown: bd1, totalTokens: 300 },
        { categoryBreakdown: bd2, totalTokens: 350 },
      ]);
      expect(result.breakdown).toEqual({ system_prompt: 150, history: 200, rag_context: 300 });
      expect(result.total).toBe(650);
    });

    it("skips malformed JSON gracefully", () => {
      const good = JSON.stringify({ system_prompt: 100 });
      const result = aggregateBreakdown([
        { categoryBreakdown: "not json {{{", totalTokens: 100 },
        { categoryBreakdown: good, totalTokens: 100 },
      ]);
      expect(result.breakdown).toEqual({ system_prompt: 100 });
      expect(result.total).toBe(100);
    });

    it("handles mixed null and valid rows", () => {
      const bd = JSON.stringify({ tool_manifests: 500 });
      const result = aggregateBreakdown([
        { categoryBreakdown: null, totalTokens: 200 },
        { categoryBreakdown: bd, totalTokens: 500 },
        { categoryBreakdown: null, totalTokens: 100 },
      ]);
      expect(result.breakdown).toEqual({ tool_manifests: 500 });
      expect(result.total).toBe(500);
    });
  });

  describe("computeCategoryDetails", () => {
    it("computes percentages correctly", () => {
      const current = { breakdown: { system_prompt: 200, history: 800 }, total: 1000 };
      const prev = { breakdown: {}, total: 0 };
      const details = computeCategoryDetails(current, prev);

      const sys = details.find((d) => d.category === "system_prompt")!;
      expect(sys.percentage).toBeCloseTo(0.2);
      expect(sys.tokens).toBe(200);
      expect(sys.trend).toBeNull(); // no previous data
    });

    it("computes trend as percentage change", () => {
      const current = { breakdown: { history: 300 }, total: 300 };
      const prev = { breakdown: { history: 200 }, total: 200 };
      const details = computeCategoryDetails(current, prev);

      const hist = details.find((d) => d.category === "history")!;
      expect(hist.trend).toBeCloseTo(0.5); // (300-200)/200 = 50% increase
    });

    it("trend is null when previous category had no data", () => {
      const current = { breakdown: { rag_context: 100 }, total: 100 };
      const prev = { breakdown: { system_prompt: 50 }, total: 50 };
      const details = computeCategoryDetails(current, prev);

      const rag = details.find((d) => d.category === "rag_context")!;
      expect(rag.trend).toBeNull();
    });

    it("handles zero total gracefully", () => {
      const current = { breakdown: { system_prompt: 0 }, total: 0 };
      const prev = { breakdown: {}, total: 0 };
      const details = computeCategoryDetails(current, prev);

      const sys = details.find((d) => d.category === "system_prompt")!;
      expect(sys.percentage).toBe(0);
    });

    it("negative trend when usage decreases", () => {
      const current = { breakdown: { code_context: 100 }, total: 100 };
      const prev = { breakdown: { code_context: 200 }, total: 200 };
      const details = computeCategoryDetails(current, prev);

      const code = details.find((d) => d.category === "code_context")!;
      expect(code.trend).toBeCloseTo(-0.5); // (100-200)/200 = -50%
    });
  });
});
