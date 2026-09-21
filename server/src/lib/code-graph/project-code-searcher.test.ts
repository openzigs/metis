/**
 * Epic #712 / Issue #714 — production wiring for fused code retrieval.
 *
 * `createDefaultCodeSearcher` reuses `HybridCodeSearch` over a Prisma-backed
 * symbol index (BM25-only, no vector store wired yet); `createDefaultSymbolLineLookup`
 * reads authoritative `startLine`/`endLine` from `CodeSymbol`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const findMany = vi.hoisted(() => vi.fn());

vi.mock("../prisma.js", () => ({
  prisma: { codeSymbol: { findMany } },
}));

import {
  createDefaultCodeSearcher,
  createDefaultSymbolLineLookup,
} from "./project-code-searcher.js";

afterEach(() => findMany.mockReset());

describe("createDefaultCodeSearcher", () => {
  it("BM25-searches the Prisma symbol index and maps results", async () => {
    findMany.mockResolvedValue([
      {
        id: "s1",
        name: "TagValidator",
        qualifiedName: "com.etag.TagValidator",
        kind: "class",
        filePath: "src/TagValidator.java",
      },
      {
        id: "s2",
        name: "Unrelated",
        qualifiedName: "com.etag.Unrelated",
        kind: "class",
        filePath: "src/Unrelated.java",
      },
    ]);

    const searcher = createDefaultCodeSearcher();
    const results = await searcher.search("TagValidator", "p1", { limit: 5 });

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { projectId: "p1" } }));
    expect(results.length).toBeGreaterThan(0);
    const top = results[0];
    expect(top.symbolId).toBe("s1");
    expect(top.filePath).toBe("src/TagValidator.java");
    expect(top.name).toBe("TagValidator");
    expect(top.kind).toBe("class");
  });

  it("returns [] when the project has no symbols (no code graph)", async () => {
    findMany.mockResolvedValue([]);
    const searcher = createDefaultCodeSearcher();
    expect(await searcher.search("anything", "p1")).toEqual([]);
  });
});

describe("createDefaultSymbolLineLookup", () => {
  it("resolves authoritative line spans from CodeSymbol", async () => {
    findMany.mockResolvedValue([{ id: "s1", filePath: "src/A.ts", startLine: 10, endLine: 42 }]);
    const lookup = createDefaultSymbolLineLookup();
    const map = await lookup.resolve(["s1"], "p1");
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["s1"] }, projectId: "p1" } }),
    );
    expect(map.get("s1")).toEqual({ filePath: "src/A.ts", startLine: 10, endLine: 42 });
  });

  it("short-circuits on an empty id list without querying", async () => {
    const lookup = createDefaultSymbolLineLookup();
    const map = await lookup.resolve([], "p1");
    expect(map.size).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});
