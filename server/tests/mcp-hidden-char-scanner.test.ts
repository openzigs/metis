/**
 * Issue #104 — hidden char scanner.
 */
import { describe, expect, it } from "vitest";
import {
  annotateHiddenChars,
  classifyHiddenChar,
  scanForHiddenChars,
  summarizeRanges,
} from "../src/lib/mcp/hidden-char-scanner.js";

describe("classifyHiddenChar", () => {
  it("recognises curated codepoints", () => {
    expect(classifyHiddenChar(0x200b)).toBe("ZWSP");
    expect(classifyHiddenChar(0x202e)).toBe("RLO");
    expect(classifyHiddenChar(0x2069)).toBe("PDI");
    expect(classifyHiddenChar(0xfeff)).toBe("BOM");
    expect(classifyHiddenChar(0x00ad)).toBe("SHY");
  });
  it("falls back to broader classes for VS / TAG", () => {
    expect(classifyHiddenChar(0xfe0f)).toBe("VS");
    expect(classifyHiddenChar(0xe0001)).toBe("TAG");
  });
  it("returns null for normal characters", () => {
    expect(classifyHiddenChar("a".codePointAt(0)!)).toBeNull();
    expect(classifyHiddenChar(0x0041)).toBeNull();
  });
});

describe("scanForHiddenChars", () => {
  it("returns empty array for plain text", () => {
    expect(scanForHiddenChars("hello world")).toEqual([]);
  });
  it("returns empty for empty string", () => {
    expect(scanForHiddenChars("")).toEqual([]);
  });
  it("locates ZWSP and RLO with correct offsets", () => {
    const text = "ab\u200bcd\u202eef";
    const out = scanForHiddenChars(text);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ label: "ZWSP", start: 2, end: 3, code: 0x200b });
    expect(out[1]).toMatchObject({ label: "RLO", start: 5, end: 6, code: 0x202e });
  });
  it("handles surrogate-pair tag chars correctly", () => {
    const text = "x" + String.fromCodePoint(0xe0041) + "y";
    const ranges = scanForHiddenChars(text);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].label).toBe("TAG");
    // surrogate pair occupies 2 code units
    expect(ranges[0].end - ranges[0].start).toBe(2);
  });
});

describe("summarizeRanges", () => {
  it("produces a sorted, deduplicated count summary", () => {
    const ranges = scanForHiddenChars("a\u200bb\u200bc\u202ed");
    expect(summarizeRanges(ranges)).toBe("RLO=1,ZWSP=2");
  });
});

describe("annotateHiddenChars", () => {
  it("returns the original string when nothing suspicious is present", () => {
    expect(annotateHiddenChars("hello")).toBe("hello");
    expect(annotateHiddenChars("")).toBe("");
  });
  it("inlines [LABEL] markers in place of every hidden char", () => {
    expect(annotateHiddenChars("a\u200bb\u202ec")).toBe("a[ZWSP]b[RLO]c");
  });
  it("handles consecutive hidden chars", () => {
    expect(annotateHiddenChars("\u200b\u202e")).toBe("[ZWSP][RLO]");
  });
});
