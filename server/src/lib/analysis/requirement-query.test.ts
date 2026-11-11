/** Issue #2233 — a requirement's text as a bounded search query. */
import { describe, expect, it } from "vitest";
import { MAX_REQUIREMENT_QUERY_CHARS, requirementQueryText } from "./requirement-query.js";

describe("requirementQueryText (#2233)", () => {
  it("returns text within the bound unchanged, whitespace included", () => {
    const text = "  Export the order history as a CSV.\n";
    expect(requirementQueryText(text)).toBe(text);
    const atBound = "x".repeat(MAX_REQUIREMENT_QUERY_CHARS);
    expect(requirementQueryText(atBound)).toBe(atBound);
  });

  it("keeps the first MAX_REQUIREMENT_QUERY_CHARS characters of a longer text, title first", () => {
    const text = `Export the order history\n${"y".repeat(40_000)}`;
    const query = requirementQueryText(text);
    expect(query).toHaveLength(MAX_REQUIREMENT_QUERY_CHARS);
    expect(query.startsWith("Export the order history\n")).toBe(true);
  });

  it("stays under the embeddings sidecar's 32,768-character input limit", () => {
    expect(MAX_REQUIREMENT_QUERY_CHARS).toBeLessThan(32_768);
  });
});
