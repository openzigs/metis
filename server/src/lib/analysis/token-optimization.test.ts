/**
 * #1225 — the `createLLMSummarizer` suite that lived here was removed with the
 * unused `ContextWindowManager` it existed to feed (see context-window-manager.ts).
 * Epic #647 / Issue #650 — RAG chunk score threshold filtering.
 */
import { describe, expect, it } from "vitest";
import { filterByScoreThreshold } from "./graph-context-builder.js";

describe("filterByScoreThreshold (#650)", () => {
  const chunks = [
    { id: "a", score: 0.8, content: "high quality" },
    { id: "b", score: 0.4, content: "medium quality" },
    { id: "c", score: 0.2, content: "low quality" },
    { id: "d", score: 0.5, content: "above threshold" },
  ];

  it("filters chunks below the threshold", () => {
    const result = filterByScoreThreshold(chunks, 0.3);
    expect(result).toHaveLength(3);
    expect(result.map((c) => c.id)).toEqual(["a", "b", "d"]);
  });

  it("includes all chunks when threshold is 0", () => {
    const result = filterByScoreThreshold(chunks, 0);
    expect(result).toHaveLength(4);
  });

  it("returns empty array when no chunks meet threshold", () => {
    const result = filterByScoreThreshold(chunks, 0.9);
    expect(result).toHaveLength(0);
  });

  it("handles empty input", () => {
    const result = filterByScoreThreshold([], 0.5);
    expect(result).toEqual([]);
  });

  it("reads threshold from env var", () => {
    const orig = process.env.RAG_SCORE_THRESHOLD;
    process.env.RAG_SCORE_THRESHOLD = "0.5";
    const result = filterByScoreThreshold(chunks);
    expect(result).toHaveLength(2);
    expect(result.map((c) => c.id)).toEqual(["a", "d"]);
    process.env.RAG_SCORE_THRESHOLD = orig;
  });

  it("defaults to 0.3 when env var not set", () => {
    const orig = process.env.RAG_SCORE_THRESHOLD;
    delete process.env.RAG_SCORE_THRESHOLD;
    const result = filterByScoreThreshold(chunks);
    expect(result).toHaveLength(3);
    process.env.RAG_SCORE_THRESHOLD = orig;
  });
});
