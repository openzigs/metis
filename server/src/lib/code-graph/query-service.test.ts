/**
 * Epic #497 / Issue #498 — Unit tests for CodeGraphQueryService.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  CodeGraphQueryService,
  type CodeGraphDataSource,
  type GraphSymbol,
  type GraphEdge,
  EDGE_TYPE_WEIGHTS,
} from "./query-service.js";

function makeSymbol(overrides: Partial<GraphSymbol> = {}): GraphSymbol {
  return {
    id: "sym-1",
    qualifiedName: "module.func",
    kind: "function",
    filePath: "src/index.ts",
    language: "ts",
    startLine: 1,
    endLine: 10,
    ...overrides,
  };
}

function makeEdge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: "edge-1",
    fromSymbolId: "sym-1",
    toSymbolId: "sym-2",
    kind: "calls",
    ...overrides,
  };
}

class MockDataSource implements CodeGraphDataSource {
  symbols: Map<string, GraphSymbol> = new Map();
  edgesFrom: Map<string, GraphEdge[]> = new Map();
  edgesTo: Map<string, GraphEdge[]> = new Map();
  fileSymbols: Map<string, GraphSymbol[]> = new Map();

  async getSymbol(symbolId: string): Promise<GraphSymbol | null> {
    return this.symbols.get(symbolId) ?? null;
  }

  async getEdgesFrom(symbolId: string): Promise<GraphEdge[]> {
    return this.edgesFrom.get(symbolId) ?? [];
  }

  async getEdgesTo(symbolId: string): Promise<GraphEdge[]> {
    return this.edgesTo.get(symbolId) ?? [];
  }

  async getSymbolsByFile(filePath: string): Promise<GraphSymbol[]> {
    return this.fileSymbols.get(filePath) ?? [];
  }

  async getSymbolsByIds(ids: string[]): Promise<GraphSymbol[]> {
    return ids.map((id) => this.symbols.get(id)).filter(Boolean) as GraphSymbol[];
  }
}

describe("CodeGraphQueryService", () => {
  let ds: MockDataSource;
  let service: CodeGraphQueryService;

  beforeEach(() => {
    ds = new MockDataSource();
    service = new CodeGraphQueryService(ds);
  });

  describe("bfsFromSymbol", () => {
    it("returns empty array when token budget is zero", async () => {
      const result = await service.bfsFromSymbol("sym-1", 3, 0);
      expect(result).toEqual([]);
    });

    it("returns empty array when start symbol has no edges", async () => {
      ds.symbols.set("sym-1", makeSymbol({ id: "sym-1" }));
      const result = await service.bfsFromSymbol("sym-1", 3, 5000);
      expect(result).toEqual([]);
    });

    it("traverses one level of BFS and returns scored symbols", async () => {
      const sym1 = makeSymbol({ id: "sym-1", qualifiedName: "main" });
      const sym2 = makeSymbol({ id: "sym-2", qualifiedName: "helper", filePath: "src/helper.ts" });
      const sym3 = makeSymbol({ id: "sym-3", qualifiedName: "util", filePath: "src/util.ts" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);
      ds.symbols.set("sym-3", sym3);

      ds.edgesFrom.set("sym-1", [
        makeEdge({ id: "e1", fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" }),
        makeEdge({ id: "e2", fromSymbolId: "sym-1", toSymbolId: "sym-3", kind: "imports" }),
      ]);

      const result = await service.bfsFromSymbol("sym-1", 2, 5000);

      expect(result).toHaveLength(2);
      // calls edge (weight 1.0) should score higher than imports (0.8)
      expect(result[0].symbol.id).toBe("sym-2");
      expect(result[0].distance).toBe(1);
      expect(result[0].score).toBeCloseTo(EDGE_TYPE_WEIGHTS.calls / 2);
      expect(result[1].symbol.id).toBe("sym-3");
      expect(result[1].score).toBeCloseTo(EDGE_TYPE_WEIGHTS.imports / 2);
    });

    it("respects maxDepth", async () => {
      const sym1 = makeSymbol({ id: "sym-1" });
      const sym2 = makeSymbol({ id: "sym-2", filePath: "src/a.ts" });
      const sym3 = makeSymbol({ id: "sym-3", filePath: "src/b.ts" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);
      ds.symbols.set("sym-3", sym3);

      ds.edgesFrom.set("sym-1", [
        makeEdge({ fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" }),
      ]);
      ds.edgesFrom.set("sym-2", [
        makeEdge({ id: "e2", fromSymbolId: "sym-2", toSymbolId: "sym-3", kind: "calls" }),
      ]);

      // maxDepth = 1 should only reach sym-2
      const result = await service.bfsFromSymbol("sym-1", 1, 5000);
      expect(result).toHaveLength(1);
      expect(result[0].symbol.id).toBe("sym-2");
    });

    it("respects token budget by limiting number of returned symbols", async () => {
      const sym1 = makeSymbol({ id: "sym-1" });
      const neighbors: GraphSymbol[] = [];
      const edges: GraphEdge[] = [];

      for (let i = 2; i <= 20; i++) {
        const sym = makeSymbol({ id: `sym-${i}`, qualifiedName: `func${i}` });
        neighbors.push(sym);
        ds.symbols.set(sym.id, sym);
        edges.push(
          makeEdge({ id: `e${i}`, fromSymbolId: "sym-1", toSymbolId: sym.id, kind: "calls" }),
        );
      }
      ds.symbols.set("sym-1", sym1);
      ds.edgesFrom.set("sym-1", edges);

      // Budget for only 3 symbols (3 * 50 = 150 tokens)
      const result = await service.bfsFromSymbol("sym-1", 3, 150);
      expect(result).toHaveLength(3);
    });

    it("includes symbols from inbound edges (bidirectional traversal)", async () => {
      const sym1 = makeSymbol({ id: "sym-1" });
      const sym2 = makeSymbol({ id: "sym-2", qualifiedName: "caller" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);

      // sym-2 calls sym-1 (inbound to sym-1)
      ds.edgesTo.set("sym-1", [
        makeEdge({ fromSymbolId: "sym-2", toSymbolId: "sym-1", kind: "calls" }),
      ]);

      const result = await service.bfsFromSymbol("sym-1", 2, 5000);
      expect(result).toHaveLength(1);
      expect(result[0].symbol.id).toBe("sym-2");
    });

    it("does not revisit already-visited nodes", async () => {
      const sym1 = makeSymbol({ id: "sym-1" });
      const sym2 = makeSymbol({ id: "sym-2" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);

      // Bidirectional edges between sym-1 and sym-2
      ds.edgesFrom.set("sym-1", [
        makeEdge({ fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" }),
      ]);
      ds.edgesFrom.set("sym-2", [
        makeEdge({ id: "e2", fromSymbolId: "sym-2", toSymbolId: "sym-1", kind: "calls" }),
      ]);

      const result = await service.bfsFromSymbol("sym-1", 3, 5000);
      // Only sym-2, not sym-1 again
      expect(result).toHaveLength(1);
      expect(result[0].symbol.id).toBe("sym-2");
    });
  });

  describe("getRelatedFiles", () => {
    it("returns empty when file has no symbols", async () => {
      const result = await service.getRelatedFiles("src/nonexistent.ts", 10);
      expect(result).toEqual([]);
    });

    it("returns related files ranked by connection strength", async () => {
      const sym1 = makeSymbol({ id: "sym-1", filePath: "src/main.ts" });
      const sym2 = makeSymbol({ id: "sym-2", filePath: "src/helper.ts" });
      const sym3 = makeSymbol({ id: "sym-3", filePath: "src/util.ts" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);
      ds.symbols.set("sym-3", sym3);

      ds.fileSymbols.set("src/main.ts", [sym1]);
      ds.edgesFrom.set("sym-1", [
        makeEdge({ fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" }),
        makeEdge({ id: "e2", fromSymbolId: "sym-1", toSymbolId: "sym-3", kind: "references" }),
      ]);

      const result = await service.getRelatedFiles("src/main.ts", 10);

      expect(result).toHaveLength(2);
      // calls (1.0) > references (0.4)
      expect(result[0].filePath).toBe("src/helper.ts");
      expect(result[1].filePath).toBe("src/util.ts");
    });

    it("does not include the source file in results", async () => {
      const sym1 = makeSymbol({ id: "sym-1", filePath: "src/main.ts" });
      const sym2 = makeSymbol({ id: "sym-2", filePath: "src/main.ts" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);

      ds.fileSymbols.set("src/main.ts", [sym1]);
      ds.edgesFrom.set("sym-1", [
        makeEdge({ fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" }),
      ]);

      const result = await service.getRelatedFiles("src/main.ts", 10);
      expect(result).toHaveLength(0);
    });

    it("respects maxResults", async () => {
      const sym1 = makeSymbol({ id: "sym-1", filePath: "src/main.ts" });
      ds.fileSymbols.set("src/main.ts", [sym1]);
      ds.symbols.set("sym-1", sym1);

      const edges: GraphEdge[] = [];
      for (let i = 2; i <= 10; i++) {
        const sym = makeSymbol({ id: `sym-${i}`, filePath: `src/file${i}.ts` });
        ds.symbols.set(sym.id, sym);
        edges.push(
          makeEdge({ id: `e${i}`, fromSymbolId: "sym-1", toSymbolId: sym.id, kind: "calls" }),
        );
      }
      ds.edgesFrom.set("sym-1", edges);

      const result = await service.getRelatedFiles("src/main.ts", 3);
      expect(result).toHaveLength(3);
    });
  });

  describe("getDependencyChain", () => {
    it("returns empty upstream/downstream when no edges exist", async () => {
      ds.symbols.set("sym-1", makeSymbol({ id: "sym-1" }));
      const result = await service.getDependencyChain("sym-1");
      expect(result.upstream).toEqual([]);
      expect(result.downstream).toEqual([]);
    });

    it("returns upstream callers", async () => {
      const sym1 = makeSymbol({ id: "sym-1" });
      const sym2 = makeSymbol({ id: "sym-2", qualifiedName: "caller" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);

      ds.edgesTo.set("sym-1", [
        makeEdge({ fromSymbolId: "sym-2", toSymbolId: "sym-1", kind: "calls" }),
      ]);

      const result = await service.getDependencyChain("sym-1");
      expect(result.upstream).toHaveLength(1);
      expect(result.upstream[0].id).toBe("sym-2");
    });

    it("returns downstream callees", async () => {
      const sym1 = makeSymbol({ id: "sym-1" });
      const sym2 = makeSymbol({ id: "sym-2", qualifiedName: "callee" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);

      ds.edgesFrom.set("sym-1", [
        makeEdge({ fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" }),
      ]);

      const result = await service.getDependencyChain("sym-1");
      expect(result.downstream).toHaveLength(1);
      expect(result.downstream[0].id).toBe("sym-2");
    });

    it("traverses multiple levels of dependencies", async () => {
      const sym1 = makeSymbol({ id: "sym-1" });
      const sym2 = makeSymbol({ id: "sym-2" });
      const sym3 = makeSymbol({ id: "sym-3" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);
      ds.symbols.set("sym-3", sym3);

      ds.edgesFrom.set("sym-1", [
        makeEdge({ fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" }),
      ]);
      ds.edgesFrom.set("sym-2", [
        makeEdge({ id: "e2", fromSymbolId: "sym-2", toSymbolId: "sym-3", kind: "calls" }),
      ]);

      const result = await service.getDependencyChain("sym-1");
      expect(result.downstream).toHaveLength(2);
      expect(result.downstream.map((s) => s.id)).toContain("sym-2");
      expect(result.downstream.map((s) => s.id)).toContain("sym-3");
    });
  });

  describe("EDGE_TYPE_WEIGHTS", () => {
    it("has correct weight ordering", () => {
      expect(EDGE_TYPE_WEIGHTS.calls).toBeGreaterThan(EDGE_TYPE_WEIGHTS.imports);
      expect(EDGE_TYPE_WEIGHTS.imports).toBeGreaterThan(EDGE_TYPE_WEIGHTS.defines);
      expect(EDGE_TYPE_WEIGHTS.defines).toBeGreaterThan(EDGE_TYPE_WEIGHTS.references);
    });
  });
});
