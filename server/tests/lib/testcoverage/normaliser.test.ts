import { describe, expect, it } from "vitest";

import {
  assertMappingOrThrow,
  finaliseCase,
  levenshtein,
  matchColumns,
  normalisePriority,
  normaliseSteps,
  normaliseTags,
} from "../../../src/lib/testcoverage/normaliser.js";
import { ColumnMappingRequiredError } from "../../../src/lib/testcoverage/types.js";

describe("testcoverage/normaliser", () => {
  describe("normalisePriority", () => {
    it.each([
      ["P1", "critical"],
      ["blocker", "critical"],
      ["High", "high"],
      ["med", "medium"],
      ["something weird", "medium"],
      [null, "medium"],
      ["", "medium"],
    ])("%s -> %s", (input, expected) => {
      expect(normalisePriority(input as string | null)).toBe(expected);
    });
  });

  describe("normaliseTags", () => {
    it("splits on commas/semicolons/pipes/newlines", () => {
      expect(normaliseTags("a, b; c | d\ne")).toEqual(["a", "b", "c", "d", "e"]);
    });
    it("returns [] for empty/null", () => {
      expect(normaliseTags(undefined)).toEqual([]);
      expect(normaliseTags("")).toEqual([]);
    });
  });

  describe("normaliseSteps", () => {
    it("strips numbering and bullets", () => {
      const steps = normaliseSteps("1. Click button\n2. See result");
      expect(steps).toEqual([{ action: "Click button" }, { action: "See result" }]);
    });
    it("splits action → expected pairs", () => {
      const steps = normaliseSteps("Click X -> Modal opens\nClose modal :: Closes");
      expect(steps).toEqual([
        { action: "Click X", expected: "Modal opens" },
        { action: "Close modal", expected: "Closes" },
      ]);
    });
    it("returns [] for empty input", () => {
      expect(normaliseSteps(undefined)).toEqual([]);
    });
  });

  describe("levenshtein", () => {
    it("identical strings -> 0", () => {
      expect(levenshtein("foo", "foo")).toBe(0);
    });
    it("classic kitten/sitting = 3", () => {
      expect(levenshtein("kitten", "sitting")).toBe(3);
    });
    it("handles empty strings", () => {
      expect(levenshtein("", "abc")).toBe(3);
      expect(levenshtein("abc", "")).toBe(3);
    });
  });

  describe("matchColumns", () => {
    it("maps a perfect header set", () => {
      const result = matchColumns(["Title", "Steps", "Expected", "Priority", "Tags"]);
      expect(result.mapping.Title).toBe("title");
      expect(result.mapping.Steps).toBe("steps");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("uses aliases (summary -> title)", () => {
      const result = matchColumns(["Summary", "Test Steps", "Expected Result"]);
      expect(result.mapping.Summary).toBe("title");
      expect(result.mapping["Test Steps"]).toBe("steps");
      expect(result.mapping["Expected Result"]).toBe("expected");
    });

    it("falls below threshold when title is missing", () => {
      const result = matchColumns(["FooField", "BarField"]);
      expect(result.confidence).toBeLessThan(0.7);
    });

    it("does not claim the same canonical column twice", () => {
      const result = matchColumns(["Title", "Name"]);
      const mapped = Object.values(result.mapping).filter((v) => v === "title");
      expect(mapped.length).toBeLessThanOrEqual(1);
    });
  });

  describe("assertMappingOrThrow", () => {
    it("throws ColumnMappingRequiredError under threshold w/ no overrides", () => {
      const match = { mapping: { Foo: null as const }, confidence: 0.4 };
      expect(() => assertMappingOrThrow(match)).toThrow(ColumnMappingRequiredError);
    });

    it("returns mapping when overrides are supplied", () => {
      const match = { mapping: { Foo: null as const }, confidence: 0.4 };
      const result = assertMappingOrThrow(match, { Foo: "title" });
      expect(result.Foo).toBe("title");
    });

    it("returns mapping when confidence meets threshold", () => {
      const match = { mapping: { Title: "title" as const }, confidence: 0.9 };
      expect(assertMappingOrThrow(match)).toEqual(match.mapping);
    });
  });

  describe("finaliseCase", () => {
    it("returns null when title is missing", () => {
      expect(finaliseCase({ title: "  " }, "csv")).toBeNull();
    });

    it("redacts PII in title/steps/expected", () => {
      const tc = finaliseCase(
        {
          title: "Login with user@example.com",
          steps: [{ action: "Email user@example.com" }],
          expected: "Sent to user@example.com",
          tags: ["smoke"],
        },
        "csv",
      );
      expect(tc).not.toBeNull();
      // Redactor replaces emails with a placeholder string; just assert the
      // original literal does not survive.
      expect(tc!.title).not.toContain("user@example.com");
      expect(tc!.steps[0].action).not.toContain("user@example.com");
      expect(tc!.expected).not.toContain("user@example.com");
    });
  });
});
