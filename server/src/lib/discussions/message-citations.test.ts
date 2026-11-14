/**
 * #2290 — an AI discussion reply's citations in its `meta` column: written as
 * JSON text only when there are some, and read back only in the shape the UI
 * renders.
 */
import { describe, expect, it } from "vitest";
import type { ChatCitation } from "@metis/shared";
import { citationsField, citationsFromMeta, discussionMessageMeta } from "./message-citations.js";

const CITED: ChatCitation[] = [
  { text: "src/a.ts:1-3", path: "src/a.ts", lines: [1, 3], status: "verified", source: "repo" },
];

describe("discussionMessageMeta / citationsFromMeta", () => {
  it("round-trips a reply's citations", () => {
    const meta = discussionMessageMeta(CITED);
    expect(JSON.parse(meta!)).toEqual({ citations: CITED });
    expect(citationsFromMeta(meta)).toEqual(CITED);
  });

  it("writes NULL for a reply that cited nothing", () => {
    expect(discussionMessageMeta([])).toBeNull();
  });

  it.each([
    ["null", null],
    ["absent", undefined],
    ["empty", ""],
    ["not JSON", "{oops"],
    ["a JSON scalar", "42"],
    ["JSON null", "null"],
    ["no citations key", '{"other":1}'],
    ["citations not a list", '{"citations":"x"}'],
  ])("reads %s as no citations", (_label, meta) => {
    expect(citationsFromMeta(meta)).toEqual([]);
  });

  it("drops an entry the UI cannot render, and keys it does not know", () => {
    const meta = JSON.stringify({
      citations: [
        { ...CITED[0], extra: "x" },
        { text: "y", path: "y", status: "made-up" },
      ],
    });
    expect(citationsFromMeta(meta)).toEqual(CITED);
  });
});

describe("citationsField", () => {
  it("is absent for none, a copy for some", () => {
    expect(citationsField([])).toEqual({});
    const field = citationsField(CITED);
    expect(field).toEqual({ citations: CITED });
    expect(field.citations).not.toBe(CITED);
  });
});
