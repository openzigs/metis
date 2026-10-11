/**
 * #1036 — edit candidates vs blast radius.
 *
 * The two lists are scored differently (edit candidates on precision and recall,
 * the blast radius on recall only), so the split has one definition, here, and
 * the read path and the UI both use it.
 */
import { describe, expect, it } from "vitest";
import { impactFileLists, impactSymbolRole } from "./impact.js";

describe("impactSymbolRole (#1036)", () => {
  it("a depth-0 symbol is an edit candidate, whatever relation found it", () => {
    expect(impactSymbolRole({ depth: 0 })).toBe("edit-candidate");
  });

  it("anything further out is blast radius", () => {
    expect(impactSymbolRole({ depth: 1 })).toBe("blast-radius");
    expect(impactSymbolRole({ depth: 2 })).toBe("blast-radius");
  });
});

describe("impactFileLists (#1036)", () => {
  const symbols = [
    { filePath: "storage/entry.go", depth: 0 },
    { filePath: "ui/mark_all_read.go", depth: 0 },
    { filePath: "storage/entry.go", depth: 0 },
    { filePath: "api/handlers.go", depth: 1 },
    { filePath: "storage/entry.go", depth: 2 },
    { filePath: "fever/handler.go", depth: 2 },
  ];

  it("lists each edit-candidate file once, in first-seen order", () => {
    expect(impactFileLists(symbols).editCandidateFiles).toEqual([
      "storage/entry.go",
      "ui/mark_all_read.go",
    ]);
  });

  it("the blast radius is the whole surface: edit candidates first, then the rest", () => {
    expect(impactFileLists(symbols).blastRadiusFiles).toEqual([
      "storage/entry.go",
      "ui/mark_all_read.go",
      "api/handlers.go",
      "fever/handler.go",
    ]);
  });

  it("a result with only blast-radius symbols has no edit candidates", () => {
    expect(impactFileLists([{ filePath: "a.go", depth: 1 }])).toEqual({
      editCandidateFiles: [],
      blastRadiusFiles: ["a.go"],
    });
  });

  it("an empty result has two empty lists", () => {
    expect(impactFileLists([])).toEqual({ editCandidateFiles: [], blastRadiusFiles: [] });
  });
});
