/**
 * Epic #497 / Issue #499 — Unit tests for RepoMapGenerator.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { RepoMapGenerator, estimateTokens } from "./repo-map.js";
import type { CodeGraphDataSource, GraphSymbol, GraphEdge } from "./query-service.js";

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

describe("RepoMapGenerator", () => {
  let ds: MockDataSource;
  let generator: RepoMapGenerator;

  beforeEach(() => {
    ds = new MockDataSource();
    generator = new RepoMapGenerator(ds);
  });

  describe("estimateTokens", () => {
    it("estimates tokens at 4 chars per token", () => {
      expect(estimateTokens("hello world")).toBe(3); // 11 chars / 4 = 2.75 → 3
      expect(estimateTokens("")).toBe(0);
      expect(estimateTokens("abcd")).toBe(1);
    });
  });

  describe("generate", () => {
    it("returns empty map when no focus files or query provided", async () => {
      const result = await generator.generate({ tokenBudget: 1000 });
      expect(result.fileCount).toBe(0);
      expect(result.content).toContain("Repository Map");
    });

    it("includes focus files with highest score", async () => {
      const sym1 = makeSymbol({ id: "sym-1", filePath: "src/main.ts", qualifiedName: "main" });
      ds.symbols.set("sym-1", sym1);
      ds.fileSymbols.set("src/main.ts", [sym1]);

      const result = await generator.generate({
        tokenBudget: 1000,
        focusFiles: ["src/main.ts"],
      });

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain("src/main.ts");
      expect(result.entries[0].score).toBe(10.0);
    });

    it("includes related files ranked by connection strength", async () => {
      const sym1 = makeSymbol({ id: "sym-1", filePath: "src/main.ts", qualifiedName: "main" });
      const sym2 = makeSymbol({ id: "sym-2", filePath: "src/helper.ts", qualifiedName: "helper" });
      const sym3 = makeSymbol({ id: "sym-3", filePath: "src/util.ts", qualifiedName: "util" });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);
      ds.symbols.set("sym-3", sym3);
      ds.fileSymbols.set("src/main.ts", [sym1]);
      ds.fileSymbols.set("src/helper.ts", [sym2]);
      ds.fileSymbols.set("src/util.ts", [sym3]);

      ds.edgesFrom.set("sym-1", [
        { id: "e1", fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" },
        { id: "e2", fromSymbolId: "sym-1", toSymbolId: "sym-3", kind: "references" },
      ]);

      const result = await generator.generate({
        tokenBudget: 5000,
        focusFiles: ["src/main.ts"],
      });

      expect(result.fileCount).toBe(3);
      // Focus file first (score 10), then helper (calls=1.0), then util (references=0.4)
      expect(result.entries[0].filePath).toBe("src/main.ts");
      expect(result.entries[1].filePath).toBe("src/helper.ts");
      expect(result.entries[2].filePath).toBe("src/util.ts");
    });

    it("respects token budget and truncates", async () => {
      const sym1 = makeSymbol({ id: "sym-1", filePath: "src/main.ts" });
      ds.symbols.set("sym-1", sym1);
      ds.fileSymbols.set("src/main.ts", [sym1]);

      // Create many related files
      const edges: GraphEdge[] = [];
      for (let i = 2; i <= 100; i++) {
        const sym = makeSymbol({
          id: `sym-${i}`,
          filePath: `src/file${i}.ts`,
          qualifiedName: `func${i}`,
        });
        ds.symbols.set(sym.id, sym);
        ds.fileSymbols.set(sym.filePath, [sym]);
        edges.push({
          id: `e${i}`,
          fromSymbolId: "sym-1",
          toSymbolId: sym.id,
          kind: "calls",
        });
      }
      ds.edgesFrom.set("sym-1", edges);

      // Very small budget — should include only a few files
      const result = await generator.generate({
        tokenBudget: 30,
        focusFiles: ["src/main.ts"],
      });

      expect(result.estimatedTokens).toBeLessThanOrEqual(30);
      expect(result.fileCount).toBeLessThan(100);
    });

    it("handles empty file symbols gracefully", async () => {
      ds.fileSymbols.set("src/empty.ts", []);

      const result = await generator.generate({
        tokenBudget: 1000,
        focusFiles: ["src/empty.ts"],
      });

      expect(result.fileCount).toBe(1);
      expect(result.content).toContain("(no symbols)");
    });

    it("completes within 500ms for large inputs", async () => {
      // Simulate a large repo with many files
      const edges: GraphEdge[] = [];
      for (let i = 1; i <= 200; i++) {
        const sym = makeSymbol({
          id: `sym-${i}`,
          filePath: `src/file${i}.ts`,
          qualifiedName: `func${i}`,
        });
        ds.symbols.set(sym.id, sym);
        ds.fileSymbols.set(sym.filePath, [sym]);
        if (i > 1) {
          edges.push({
            id: `e${i}`,
            fromSymbolId: "sym-1",
            toSymbolId: sym.id,
            kind: "calls",
          });
        }
      }
      ds.edgesFrom.set("sym-1", edges);

      const start = performance.now();
      await generator.generate({
        tokenBudget: 5000,
        focusFiles: ["src/file1.ts"],
      });
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(500);
    });

    it("merges query-ranked files with focus-file entries", async () => {
      // Use a subclass that returns matches from findSymbolsByNamePattern
      class SearchableRepoMapGenerator extends RepoMapGenerator {
        private searchSymbols: GraphSymbol[];
        constructor(dataSource: CodeGraphDataSource, searchSymbols: GraphSymbol[]) {
          super(dataSource);
          this.searchSymbols = searchSymbols;
        }
        protected async findSymbolsByNamePattern(pattern: string): Promise<GraphSymbol[]> {
          return this.searchSymbols.filter((s) =>
            s.qualifiedName.toLowerCase().includes(pattern.toLowerCase()),
          );
        }
      }

      const sym1 = makeSymbol({ id: "sym-1", filePath: "src/main.ts", qualifiedName: "main" });
      const sym2 = makeSymbol({
        id: "sym-2",
        filePath: "src/auth.ts",
        qualifiedName: "authenticate",
      });
      const sym3 = makeSymbol({
        id: "sym-3",
        filePath: "src/main.ts",
        qualifiedName: "authHelper",
      });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);
      ds.symbols.set("sym-3", sym3);
      ds.fileSymbols.set("src/main.ts", [sym1, sym3]);
      ds.fileSymbols.set("src/auth.ts", [sym2]);

      const searchGen = new SearchableRepoMapGenerator(ds, [sym2, sym3]);

      const result = await searchGen.generate({
        tokenBudget: 5000,
        focusFiles: ["src/main.ts"],
        query: "auth",
      });

      // src/main.ts from focus (score 10) + query match (merged via Math.max)
      // src/auth.ts from query only (pushed as new entry)
      expect(result.fileCount).toBeGreaterThanOrEqual(2);
      expect(result.entries.some((e) => e.filePath === "src/auth.ts")).toBe(true);
      expect(result.entries.some((e) => e.filePath === "src/main.ts")).toBe(true);
    });

    it("accumulates scores for multiple query term matches on same file", async () => {
      class SearchableRepoMapGenerator extends RepoMapGenerator {
        private searchSymbols: GraphSymbol[];
        constructor(dataSource: CodeGraphDataSource, searchSymbols: GraphSymbol[]) {
          super(dataSource);
          this.searchSymbols = searchSymbols;
        }
        protected async findSymbolsByNamePattern(pattern: string): Promise<GraphSymbol[]> {
          return this.searchSymbols.filter((s) =>
            s.qualifiedName.toLowerCase().includes(pattern.toLowerCase()),
          );
        }
      }

      const sym1 = makeSymbol({
        id: "sym-1",
        filePath: "src/user-auth.ts",
        qualifiedName: "userAuth",
      });
      const sym2 = makeSymbol({
        id: "sym-2",
        filePath: "src/user-auth.ts",
        qualifiedName: "userLogin",
      });

      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);
      ds.fileSymbols.set("src/user-auth.ts", [sym1, sym2]);

      const searchGen = new SearchableRepoMapGenerator(ds, [sym1, sym2]);

      // Both "user" terms should match both symbols, accumulating score
      const result = await searchGen.generate({
        tokenBudget: 5000,
        query: "user login",
      });

      expect(result.fileCount).toBeGreaterThanOrEqual(1);
      expect(result.entries.some((e) => e.filePath === "src/user-auth.ts")).toBe(true);
      // Score should be > 1.0 because multiple matches accumulated
      const entry = result.entries.find((e) => e.filePath === "src/user-auth.ts");
      expect(entry!.score).toBeGreaterThan(1.0);
    });
  });
});
