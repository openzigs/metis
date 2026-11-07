/**
 * #1036 — edit candidates vs blast radius.
 *
 * The two lists are scored differently (edit candidates on precision and recall,
 * the blast radius on recall only), so the split has one definition, here, and
 * the read path and the UI both use it.
 */
import { describe, expect, it } from "vitest";
import { impactFileKey, impactFileLists, impactRepoCount, impactSymbolRole } from "./impact.js";

/** A file with no known repository: what a single-repo project's rows read as. */
const file = (filePath: string, repoConnectionId: string | null = null) => ({
  repoConnectionId,
  filePath,
});

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
      file("storage/entry.go"),
      file("ui/mark_all_read.go"),
    ]);
  });

  it("the blast radius is the whole surface: edit candidates first, then the rest", () => {
    expect(impactFileLists(symbols).blastRadiusFiles).toEqual([
      file("storage/entry.go"),
      file("ui/mark_all_read.go"),
      file("api/handlers.go"),
      file("fever/handler.go"),
    ]);
  });

  it("a result with only blast-radius symbols has no edit candidates", () => {
    expect(impactFileLists([{ filePath: "a.go", depth: 1 }])).toEqual({
      editCandidateFiles: [],
      blastRadiusFiles: [file("a.go")],
    });
  });

  it("an empty result has two empty lists", () => {
    expect(impactFileLists([])).toEqual({ editCandidateFiles: [], blastRadiusFiles: [] });
  });
});

describe("multi-repo projects (#1965)", () => {
  const orders = { id: "rc-orders", name: "metis-fixture-orders" };
  const billing = { id: "rc-billing", name: "metis-fixture-billing" };
  // The live check's shape: `src/types/order.ts` exists in orders AND billing.
  const symbols = [
    { filePath: "src/types/order.ts", depth: 0, repo: orders },
    { filePath: "src/types/order.ts", depth: 0, repo: billing },
    { filePath: "src/types/order.ts", depth: 0, repo: orders },
    { filePath: "src/api/orders.ts", depth: 1, repo: orders },
    { filePath: "src/types/order.ts", depth: 2, repo: billing },
  ];

  it("keeps a same-path file in two repositories as two files to edit", () => {
    expect(impactFileLists(symbols).editCandidateFiles).toEqual([
      file("src/types/order.ts", "rc-orders"),
      file("src/types/order.ts", "rc-billing"),
    ]);
  });

  it("counts them as two files in the blast radius too", () => {
    expect(impactFileLists(symbols).blastRadiusFiles).toEqual([
      file("src/types/order.ts", "rc-orders"),
      file("src/types/order.ts", "rc-billing"),
      file("src/api/orders.ts", "rc-orders"),
    ]);
  });

  it("keys a file by repository and path, so neither alone collides", () => {
    expect(impactFileKey({ filePath: "a.ts", repo: orders })).not.toBe(
      impactFileKey({ filePath: "a.ts", repo: billing }),
    );
    expect(impactFileKey({ filePath: "a.ts", repo: orders })).not.toBe(
      impactFileKey({ filePath: "b.ts", repo: orders }),
    );
    expect(impactFileKey({ filePath: "a.ts" })).toBe(
      impactFileKey({ filePath: "a.ts", repo: null }),
    );
  });

  it("counts the distinct known repositories, never an unknown one", () => {
    expect(impactRepoCount(symbols)).toBe(2);
    expect(impactRepoCount([{ repo: orders }, { repo: null }, {}])).toBe(1);
    expect(impactRepoCount([])).toBe(0);
  });
});
