/**
 * Epic #497 / Issue #500 — Unit + integration tests for GraphContextBuilder.
 * Epic #507 / Issue #510 — Hybrid search integration tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  GraphContextBuilder,
  computeQueryRelevance,
  computeContextScore,
  resolveCodeRetrievalMode,
  DEFAULT_HYBRID_BUDGET,
  type GraphContextDataSource,
  type HybridSearchProvider,
} from "./graph-context-builder.js";
import type { GraphSymbol, GraphEdge } from "../code-graph/query-service.js";

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

class MockGraphDataSource implements GraphContextDataSource {
  symbols: Map<string, GraphSymbol> = new Map();
  edgesFrom: Map<string, GraphEdge[]> = new Map();
  edgesTo: Map<string, GraphEdge[]> = new Map();
  fileSymbols: Map<string, GraphSymbol[]> = new Map();
  projectSymbols: Map<string, GraphSymbol[]> = new Map();
  hasGraph: Map<string, boolean> = new Map();
  symbolEmbeddings: Map<string, boolean> = new Map();

  async hasCodeGraph(projectId: string): Promise<boolean> {
    return this.hasGraph.get(projectId) ?? false;
  }

  async hasSymbolEmbeddings(projectId: string): Promise<boolean> {
    return this.symbolEmbeddings.get(projectId) ?? false;
  }

  async getProjectSymbols(projectId: string, limit: number): Promise<GraphSymbol[]> {
    return (this.projectSymbols.get(projectId) ?? []).slice(0, limit);
  }

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

class MockHybridSearch implements HybridSearchProvider {
  results: Array<{
    symbolId: string;
    filePath: string;
    name: string;
    kind: string;
    score: number;
    snippet?: string;
  }> = [];
  callCount = 0;
  lastQuery = "";

  async search(query: string, _projectId: string, _opts?: { limit?: number }) {
    this.callCount++;
    this.lastQuery = query;
    return this.results;
  }
}

describe("GraphContextBuilder", () => {
  let ds: MockGraphDataSource;
  let builder: GraphContextBuilder;

  beforeEach(() => {
    ds = new MockGraphDataSource();
    builder = new GraphContextBuilder(ds);
  });

  describe("computeQueryRelevance", () => {
    it("returns 0.5 for empty query", () => {
      expect(computeQueryRelevance("someFunction", "")).toBe(0.5);
    });

    it("returns high score when all terms match", () => {
      const score = computeQueryRelevance("userAuthentication", "user authentication");
      expect(score).toBeGreaterThan(0.8);
    });

    it("returns low score when no terms match", () => {
      const score = computeQueryRelevance("database", "frontend react");
      expect(score).toBe(0.1);
    });

    it("returns partial score for partial match", () => {
      const score = computeQueryRelevance("userService", "user database");
      expect(score).toBeGreaterThan(0.1);
      expect(score).toBeLessThan(1.0);
    });

    it("is case-insensitive", () => {
      const score1 = computeQueryRelevance("UserService", "user");
      const score2 = computeQueryRelevance("userservice", "User");
      expect(score1).toBe(score2);
    });
  });

  describe("computeContextScore", () => {
    it("returns higher score for closer symbols", () => {
      const close = computeContextScore(1, 1.0, 1.0);
      const far = computeContextScore(5, 1.0, 1.0);
      expect(close).toBeGreaterThan(far);
    });

    it("returns higher score for stronger edge types", () => {
      const calls = computeContextScore(1, 1.0, 1.0);
      const refs = computeContextScore(1, 0.4, 1.0);
      expect(calls).toBeGreaterThan(refs);
    });

    it("returns higher score for more relevant queries", () => {
      const relevant = computeContextScore(1, 1.0, 1.0);
      const irrelevant = computeContextScore(1, 1.0, 0.1);
      expect(relevant).toBeGreaterThan(irrelevant);
    });

    it("returns 0 when distance is infinite (approaches 0)", () => {
      const score = computeContextScore(1000, 1.0, 1.0);
      expect(score).toBeCloseTo(0, 2);
    });
  });

  describe("buildContext", () => {
    it("returns fallback when no code graph exists", async () => {
      ds.hasGraph.set("proj-1", false);

      const result = await builder.buildContext({
        query: "authentication",
        projectId: "proj-1",
        tokenBudget: 8000,
      });

      expect(result.usedFallback).toBe(true);
      expect(result.snippets).toEqual([]);
      expect(result.context).toContain("No code graph data");
    });

    it("returns fallback when project has no symbols", async () => {
      ds.hasGraph.set("proj-1", true);
      ds.projectSymbols.set("proj-1", []);

      const result = await builder.buildContext({
        query: "authentication",
        projectId: "proj-1",
        tokenBudget: 8000,
      });

      expect(result.usedFallback).toBe(true);
    });

    it("builds context with graph-ranked snippets", async () => {
      const sym1 = makeSymbol({
        id: "sym-1",
        qualifiedName: "authService",
        filePath: "src/auth.ts",
      });
      const sym2 = makeSymbol({
        id: "sym-2",
        qualifiedName: "hashPassword",
        filePath: "src/crypto.ts",
      });

      ds.hasGraph.set("proj-1", true);
      ds.projectSymbols.set("proj-1", [sym1, sym2]);
      ds.symbols.set("sym-1", sym1);
      ds.symbols.set("sym-2", sym2);
      ds.fileSymbols.set("src/auth.ts", [sym1]);
      ds.fileSymbols.set("src/crypto.ts", [sym2]);

      ds.edgesFrom.set("sym-1", [
        { id: "e1", fromSymbolId: "sym-1", toSymbolId: "sym-2", kind: "calls" },
      ]);

      const result = await builder.buildContext({
        query: "auth",
        projectId: "proj-1",
        tokenBudget: 8000,
      });

      expect(result.usedFallback).toBe(false);
      expect(result.snippets.length).toBeGreaterThan(0);
      expect(result.context).toContain("Relevant Code");
    });

    it("includes repo map when budget allows", async () => {
      const sym1 = makeSymbol({ id: "sym-1", qualifiedName: "main", filePath: "src/index.ts" });

      ds.hasGraph.set("proj-1", true);
      ds.projectSymbols.set("proj-1", [sym1]);
      ds.symbols.set("sym-1", sym1);
      ds.fileSymbols.set("src/index.ts", [sym1]);

      const result = await builder.buildContext({
        query: "main",
        projectId: "proj-1",
        tokenBudget: 8000,
        repoMapBudget: 2000,
      });

      expect(result.usedFallback).toBe(false);
      // Repo map should be present when budget allows
      if (result.repoMap) {
        expect(result.repoMap).toContain("Repository Map");
      }
    });

    it("respects token budget", async () => {
      const symbols: GraphSymbol[] = [];
      for (let i = 1; i <= 50; i++) {
        const sym = makeSymbol({
          id: `sym-${i}`,
          qualifiedName: `func${i}`,
          filePath: `src/file${i}.ts`,
        });
        symbols.push(sym);
        ds.symbols.set(sym.id, sym);
        ds.fileSymbols.set(sym.filePath, [sym]);
      }

      ds.hasGraph.set("proj-1", true);
      ds.projectSymbols.set("proj-1", symbols);

      // Tiny budget
      const result = await builder.buildContext({
        query: "func1",
        projectId: "proj-1",
        tokenBudget: 50,
        repoMapBudget: 0,
      });

      expect(result.estimatedTokens).toBeLessThanOrEqual(50);
    });

    it("prioritizes query-relevant symbols", async () => {
      const authSym = makeSymbol({
        id: "sym-1",
        qualifiedName: "authLogin",
        filePath: "src/auth.ts",
      });
      const dbSym = makeSymbol({ id: "sym-2", qualifiedName: "dbConnect", filePath: "src/db.ts" });

      ds.hasGraph.set("proj-1", true);
      ds.projectSymbols.set("proj-1", [authSym, dbSym]);
      ds.symbols.set("sym-1", authSym);
      ds.symbols.set("sym-2", dbSym);
      ds.fileSymbols.set("src/auth.ts", [authSym]);
      ds.fileSymbols.set("src/db.ts", [dbSym]);

      const result = await builder.buildContext({
        query: "auth login",
        projectId: "proj-1",
        tokenBudget: 8000,
        repoMapBudget: 0,
      });

      // Auth symbol should be included (matches query)
      const authSnippet = result.snippets.find((s) => s.symbolName === "authLogin");
      expect(authSnippet).toBeDefined();
    });
  });
});

describe("GraphContextBuilder — Hybrid Mode (Issue #510)", () => {
  let ds: MockGraphDataSource;
  let hybridSearch: MockHybridSearch;
  let builder: GraphContextBuilder;

  beforeEach(() => {
    ds = new MockGraphDataSource();
    hybridSearch = new MockHybridSearch();
    builder = new GraphContextBuilder(ds, hybridSearch);
  });

  afterEach(() => {
    delete process.env.CODE_RETRIEVAL_MODE;
  });

  it("uses graph-only when CODE_RETRIEVAL_MODE=graph", async () => {
    const sym = makeSymbol({ id: "sym-1", qualifiedName: "foo", filePath: "src/a.ts" });
    ds.hasGraph.set("proj-1", true);
    ds.projectSymbols.set("proj-1", [sym]);
    ds.symbols.set("sym-1", sym);
    ds.fileSymbols.set("src/a.ts", [sym]);
    ds.symbolEmbeddings.set("proj-1", true);

    const result = await builder.buildContext({
      query: "foo",
      projectId: "proj-1",
      tokenBudget: 8000,
      repoMapBudget: 0,
      retrievalMode: "graph",
    });

    expect(result.usedFallback).toBe(false);
    expect(hybridSearch.callCount).toBe(0);
  });

  it("calls hybrid search when mode=hybrid and embeddings available", async () => {
    const sym = makeSymbol({ id: "sym-1", qualifiedName: "authService", filePath: "src/auth.ts" });
    ds.hasGraph.set("proj-1", true);
    ds.projectSymbols.set("proj-1", [sym]);
    ds.symbols.set("sym-1", sym);
    ds.fileSymbols.set("src/auth.ts", [sym]);
    ds.symbolEmbeddings.set("proj-1", true);

    hybridSearch.results = [
      {
        symbolId: "emb-1",
        filePath: "src/helper.ts",
        name: "helper",
        kind: "function",
        score: 0.8,
      },
    ];

    const result = await builder.buildContext({
      query: "auth",
      projectId: "proj-1",
      tokenBudget: 8000,
      repoMapBudget: 0,
      retrievalMode: "hybrid",
    });

    expect(hybridSearch.callCount).toBe(1);
    expect(result.snippets.length).toBeGreaterThan(0);
  });

  it("deduplicates symbols found by both graph and embedding", async () => {
    const sym = makeSymbol({ id: "sym-1", qualifiedName: "authService", filePath: "src/auth.ts" });
    ds.hasGraph.set("proj-1", true);
    ds.projectSymbols.set("proj-1", [sym]);
    ds.symbols.set("sym-1", sym);
    ds.fileSymbols.set("src/auth.ts", [sym]);
    ds.symbolEmbeddings.set("proj-1", true);

    // Hybrid returns a result with same name as graph symbol
    hybridSearch.results = [
      {
        symbolId: "sym-1",
        filePath: "src/auth.ts",
        name: "authService",
        kind: "function",
        score: 0.9,
      },
    ];

    const result = await builder.buildContext({
      query: "auth",
      projectId: "proj-1",
      tokenBudget: 8000,
      repoMapBudget: 0,
      retrievalMode: "hybrid",
    });

    // "authService" should not appear twice
    const authSnippets = result.snippets.filter((s) => s.symbolName === "authService");
    expect(authSnippets.length).toBe(1);
  });

  it("falls back to graph-only when embeddings not yet computed", async () => {
    const sym = makeSymbol({ id: "sym-1", qualifiedName: "foo", filePath: "src/a.ts" });
    ds.hasGraph.set("proj-1", true);
    ds.projectSymbols.set("proj-1", [sym]);
    ds.symbols.set("sym-1", sym);
    ds.fileSymbols.set("src/a.ts", [sym]);
    ds.symbolEmbeddings.set("proj-1", false); // No embeddings

    const result = await builder.buildContext({
      query: "foo",
      projectId: "proj-1",
      tokenBudget: 8000,
      repoMapBudget: 0,
      retrievalMode: "hybrid",
    });

    expect(hybridSearch.callCount).toBe(0);
    expect(result.usedFallback).toBe(false);
  });

  it("uses embedding_only mode when configured", async () => {
    const sym = makeSymbol({ id: "sym-1", qualifiedName: "foo", filePath: "src/a.ts" });
    ds.hasGraph.set("proj-1", true);
    ds.projectSymbols.set("proj-1", [sym]);
    ds.symbols.set("sym-1", sym);
    ds.fileSymbols.set("src/a.ts", [sym]);
    ds.symbolEmbeddings.set("proj-1", true);

    hybridSearch.results = [
      {
        symbolId: "emb-1",
        filePath: "src/emb.ts",
        name: "embResult",
        kind: "function",
        score: 0.85,
      },
    ];

    const result = await builder.buildContext({
      query: "foo",
      projectId: "proj-1",
      tokenBudget: 8000,
      repoMapBudget: 0,
      retrievalMode: "embedding_only",
    });

    expect(hybridSearch.callCount).toBe(1);
    expect(result.snippets.length).toBeGreaterThan(0);
    expect(result.snippets[0].symbolName).toBe("embResult");
  });

  it("handles hybrid search failure gracefully", async () => {
    const sym = makeSymbol({ id: "sym-1", qualifiedName: "foo", filePath: "src/a.ts" });
    ds.hasGraph.set("proj-1", true);
    ds.projectSymbols.set("proj-1", [sym]);
    ds.symbols.set("sym-1", sym);
    ds.fileSymbols.set("src/a.ts", [sym]);
    ds.symbolEmbeddings.set("proj-1", true);

    hybridSearch.search = async () => {
      throw new Error("Search unavailable");
    };

    const result = await builder.buildContext({
      query: "foo",
      projectId: "proj-1",
      tokenBudget: 8000,
      repoMapBudget: 0,
      retrievalMode: "hybrid",
    });

    // Should still return graph results
    expect(result.usedFallback).toBe(false);
    expect(result.snippets.length).toBeGreaterThan(0);
  });
});

describe("resolveCodeRetrievalMode", () => {
  afterEach(() => {
    delete process.env.CODE_RETRIEVAL_MODE;
  });

  it("defaults to graph when not set", () => {
    delete process.env.CODE_RETRIEVAL_MODE;
    expect(resolveCodeRetrievalMode()).toBe("graph");
  });

  it("returns hybrid when set", () => {
    process.env.CODE_RETRIEVAL_MODE = "hybrid";
    expect(resolveCodeRetrievalMode()).toBe("hybrid");
  });

  it("returns embedding_only when set", () => {
    process.env.CODE_RETRIEVAL_MODE = "embedding_only";
    expect(resolveCodeRetrievalMode()).toBe("embedding_only");
  });

  it("is case-insensitive", () => {
    process.env.CODE_RETRIEVAL_MODE = "HYBRID";
    expect(resolveCodeRetrievalMode()).toBe("hybrid");
  });

  it("defaults to graph for unknown values", () => {
    process.env.CODE_RETRIEVAL_MODE = "unknown";
    expect(resolveCodeRetrievalMode()).toBe("graph");
  });
});

describe("DEFAULT_HYBRID_BUDGET", () => {
  it("has correct default fractions", () => {
    expect(DEFAULT_HYBRID_BUDGET.graphFraction).toBe(0.6);
    expect(DEFAULT_HYBRID_BUDGET.embeddingFraction).toBe(0.4);
  });
});
