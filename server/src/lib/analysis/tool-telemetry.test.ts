/**
 * P0 #774 (AC 4) — the pure tool-call summarizer persisted on the AgentResult.
 * The pipeline-level wiring is covered in `tool-telemetry-pipeline.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { isToolErrorResult, summarizeToolCalls } from "./tool-telemetry.js";

describe("#774 summarizeToolCalls", () => {
  it("counts calls and errors per tool, preserving first-use order", () => {
    const summary = summarizeToolCalls([
      { tool: "search_code_graph", result: "class Foo — a.ts:1-2 [ts]" },
      { tool: "search_code_symbols", result: 'Error: search_code_symbols requires "query"' },
      { tool: "search_code_graph", result: "Error: search_code_graph needs at least one filter" },
      { tool: "read_file_slice", result: "a.ts (lines 1-3 of 9)" },
    ]);

    expect(summary.totalCalls).toBe(4);
    expect(summary.errorCalls).toBe(2);
    expect(summary.byTool).toEqual([
      { tool: "search_code_graph", calls: 2, errors: 1 },
      { tool: "search_code_symbols", calls: 1, errors: 1 },
      { tool: "read_file_slice", calls: 1, errors: 0 },
    ]);
    expect(summary.errorSamples.map((s) => s.tool)).toEqual([
      "search_code_symbols",
      "search_code_graph",
    ]);
  });

  it("is empty (never undefined) for a run that called no tools", () => {
    expect(summarizeToolCalls([])).toEqual({
      totalCalls: 0,
      errorCalls: 0,
      byTool: [],
      errorSamples: [],
    });
  });

  it("BOUNDS what it retains: ≤5 samples, ≤240 chars each", () => {
    const summary = summarizeToolCalls(
      Array.from({ length: 12 }, () => ({
        tool: "list_files",
        result: "Error: " + "x".repeat(5000),
      })),
    );
    expect(summary.totalCalls).toBe(12);
    expect(summary.errorCalls).toBe(12);
    expect(summary.errorSamples).toHaveLength(5);
    for (const sample of summary.errorSamples) {
      expect(sample.message.length).toBeLessThanOrEqual(240);
    }
  });

  it("falls back to the preview when the full result is absent", () => {
    const summary = summarizeToolCalls([{ tool: "list_files", resultPreview: "Error: nope" }]);
    expect(summary.errorCalls).toBe(1);
    expect(summary.errorSamples[0]?.message).toBe("Error: nope");
  });

  it("isToolErrorResult recognises the tools' error convention only", () => {
    expect(isToolErrorResult("Error: query is required")).toBe(true);
    expect(isToolErrorResult("  error executing tool: boom")).toBe(true);
    expect(isToolErrorResult("No symbols found matching the query.")).toBe(false);
    expect(isToolErrorResult("class ErrorHandler — a.ts:1-2 [ts]")).toBe(false);
    expect(isToolErrorResult(undefined)).toBe(false);
  });
});
