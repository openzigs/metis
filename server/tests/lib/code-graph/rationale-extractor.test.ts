/**
 * Issue #311 — Rationale extractor tests.
 */
import { describe, it, expect } from "vitest";
import { extractRationale } from "../../../src/lib/code-graph/rationale-extractor.js";
import type { ParsedFile } from "../../../src/lib/code-graph/parsers.js";

function makeParsedFile(overrides: Partial<ParsedFile> = {}): ParsedFile {
  return {
    filePath: "src/x.ts",
    language: "ts",
    fileHash: "abc",
    symbols: [],
    edges: [],
    rationaleHints: [],
    ...overrides,
  };
}

describe("extractRationale", () => {
  it("returns empty when there are no hints", () => {
    expect(extractRationale(makeParsedFile())).toEqual([]);
  });

  it("links a WHY hint to the symbol on the next line", () => {
    const parsed = makeParsedFile({
      symbols: [
        {
          kind: "module",
          name: "x.ts",
          qualifiedName: "src/x.ts",
          startLine: 1,
          endLine: 20,
          contentHash: "h",
        },
        {
          kind: "function",
          name: "doThing",
          qualifiedName: "src/x.ts::doThing",
          startLine: 5,
          endLine: 8,
          contentHash: "h2",
        },
      ],
      rationaleHints: [{ startLine: 4, endLine: 4, tag: "WHY", text: "this is the reason" }],
    });
    const findings = extractRationale(parsed);
    expect(findings).toHaveLength(1);
    expect(findings[0].symbolQualifiedName).toBe("src/x.ts::doThing");
    expect(findings[0].tag).toBe("rationale");
    expect(findings[0].title).toContain("WHY on doThing");
  });

  it("classifies TODO and HACK as rationale-todo", () => {
    const parsed = makeParsedFile({
      symbols: [
        {
          kind: "module",
          name: "x.ts",
          qualifiedName: "src/x.ts",
          startLine: 1,
          endLine: 10,
          contentHash: "h",
        },
      ],
      rationaleHints: [
        { startLine: 1, endLine: 1, tag: "TODO", text: "fix later" },
        { startLine: 2, endLine: 2, tag: "HACK", text: "temporary" },
      ],
    });
    const findings = extractRationale(parsed);
    expect(findings.every((f) => f.tag === "rationale-todo")).toBe(true);
  });

  it("attaches to module scope when no symbol is nearby", () => {
    const parsed = makeParsedFile({
      symbols: [
        {
          kind: "module",
          name: "x.ts",
          qualifiedName: "src/x.ts",
          startLine: 1,
          endLine: 100,
          contentHash: "h",
        },
      ],
      rationaleHints: [{ startLine: 50, endLine: 50, tag: "NOTE", text: "orphan note" }],
    });
    const findings = extractRationale(parsed);
    expect(findings).toHaveLength(1);
    expect(findings[0].symbolQualifiedName).toBeNull();
  });

  it("dedupes hints with identical text under the same symbol", () => {
    const parsed = makeParsedFile({
      symbols: [
        {
          kind: "module",
          name: "x.ts",
          qualifiedName: "src/x.ts",
          startLine: 1,
          endLine: 30,
          contentHash: "h",
        },
        {
          kind: "function",
          name: "f",
          qualifiedName: "src/x.ts::f",
          startLine: 5,
          endLine: 8,
          contentHash: "h",
        },
      ],
      rationaleHints: [
        { startLine: 4, endLine: 4, tag: "WHY", text: "Same text" },
        { startLine: 4, endLine: 4, tag: "WHY", text: "same   text" }, // normalised match
      ],
    });
    const findings = extractRationale(parsed);
    expect(findings).toHaveLength(1);
  });

  it("links a JSDoc block enclosed inside a symbol", () => {
    const parsed = makeParsedFile({
      symbols: [
        {
          kind: "module",
          name: "x.ts",
          qualifiedName: "src/x.ts",
          startLine: 1,
          endLine: 30,
          contentHash: "h",
        },
        {
          kind: "function",
          name: "f",
          qualifiedName: "src/x.ts::f",
          startLine: 5,
          endLine: 20,
          contentHash: "h",
        },
      ],
      rationaleHints: [{ startLine: 6, endLine: 8, tag: "JSDOC", text: "Documents f." }],
    });
    const findings = extractRationale(parsed);
    expect(findings).toHaveLength(1);
    expect(findings[0].symbolQualifiedName).toBe("src/x.ts::f");
    expect(findings[0].title).toBe("jsdoc on f");
  });

  it("truncates long titles", () => {
    const longText = "x".repeat(200);
    const parsed = makeParsedFile({
      symbols: [
        {
          kind: "module",
          name: "x.ts",
          qualifiedName: "src/x.ts",
          startLine: 1,
          endLine: 5,
          contentHash: "h",
        },
      ],
      rationaleHints: [{ startLine: 1, endLine: 1, tag: "WHY", text: longText }],
    });
    const findings = extractRationale(parsed);
    expect(findings[0].title.length).toBeLessThanOrEqual(120);
    expect(findings[0].title).toContain("...");
  });

  it("preserves the full description even when title is truncated", () => {
    const longText = "y".repeat(200);
    const parsed = makeParsedFile({
      symbols: [
        {
          kind: "module",
          name: "x.ts",
          qualifiedName: "src/x.ts",
          startLine: 1,
          endLine: 5,
          contentHash: "h",
        },
      ],
      rationaleHints: [{ startLine: 1, endLine: 1, tag: "WHY", text: longText }],
    });
    const findings = extractRationale(parsed);
    expect(findings[0].description).toBe(longText);
  });
});
