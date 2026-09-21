/**
 * Epic #507 / Issue #509 — Unit tests for HybridCodeSearch.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  HybridCodeSearch,
  BM25Index,
  reciprocalRankFusion,
  matchGlob,
  tokenizeCode,
  tokenizeCodeRoots,
  buildSymbolDocumentText,
  DEFAULT_LEXICAL_CONFIG,
  DEFAULT_WEIGHTS,
  type SearchableSymbol,
  type SymbolVectorStore,
  type SymbolIndex,
  type VectorSearchHit,
} from "./hybrid-search.js";
import type { EmbedService } from "./symbol-embeddings.js";

// ---- Mocks ----------------------------------------------------------------

function makeSearchableSymbol(overrides: Partial<SearchableSymbol> = {}): SearchableSymbol {
  return {
    symbolId: "sym-1",
    name: "handleRequest",
    qualifiedName: "server.handleRequest",
    kind: "function",
    filePath: "src/server.ts",
    signature: "function handleRequest(req: Request): Response",
    docstring: "Handles an incoming HTTP request.",
    snippet: "function handleRequest(req) { ... }",
    ...overrides,
  };
}

class MockVectorStore implements SymbolVectorStore {
  results: VectorSearchHit[] = [];
  lastQuery: number[] = [];
  lastK = 0;

  async search(_projectId: string, queryVector: number[], k: number): Promise<VectorSearchHit[]> {
    this.lastQuery = queryVector;
    this.lastK = k;
    return this.results.slice(0, k);
  }
}

class MockSymbolIndex implements SymbolIndex {
  symbols: SearchableSymbol[] = [];

  async getSymbols(_projectId: string): Promise<SearchableSymbol[]> {
    return this.symbols;
  }
}

class MockEmbedService implements EmbedService {
  callCount = 0;

  async embed(texts: string[]) {
    this.callCount++;
    return {
      vectors: texts.map(() => Array(384).fill(0.5)),
      model: "test-model",
      dimension: 384,
    };
  }
}

// ---- BM25Index Tests ------------------------------------------------------

describe("BM25Index", () => {
  let index: BM25Index;

  beforeEach(() => {
    index = new BM25Index();
  });

  it("returns empty for empty index", () => {
    index.build([]);
    const results = index.score("anything");
    expect(results).toEqual([]);
  });

  it("returns empty for empty query", () => {
    index.build([makeSearchableSymbol()]);
    const results = index.score("");
    expect(results).toEqual([]);
  });

  it("scores documents matching query terms higher", () => {
    const symbols = [
      makeSearchableSymbol({
        symbolId: "s1",
        name: "handleRequest",
        signature: "handle HTTP request",
      }),
      makeSearchableSymbol({ symbolId: "s2", name: "parseConfig", signature: "parse config file" }),
      makeSearchableSymbol({ symbolId: "s3", name: "logError", signature: "log an error" }),
    ];

    index.build(symbols);
    const results = index.score("handle request");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].symbolId).toBe("s1");
  });

  it("handles multiple matching documents", () => {
    const symbols = [
      makeSearchableSymbol({ symbolId: "s1", name: "userAuth", docstring: "authenticate user" }),
      makeSearchableSymbol({ symbolId: "s2", name: "userProfile", docstring: "get user profile" }),
    ];

    index.build(symbols);
    const results = index.score("user");

    expect(results.length).toBe(2);
    // Both should have scores since both contain "user"
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[1].score).toBeGreaterThan(0);
  });

  it("is case insensitive", () => {
    const symbols = [makeSearchableSymbol({ symbolId: "s1", name: "MyClass" })];
    index.build(symbols);

    const r1 = index.score("myclass");
    const r2 = index.score("MYCLASS");
    expect(r1[0]?.score).toBe(r2[0]?.score);
  });

  it("handles symbols with no matching terms", () => {
    index.build([makeSearchableSymbol({ symbolId: "s1", name: "foo" })]);
    const results = index.score("zzzzunmatched");
    expect(results).toEqual([]);
  });
});

// ---- reciprocalRankFusion Tests -------------------------------------------

describe("reciprocalRankFusion", () => {
  it("returns empty for empty lists", () => {
    const result = reciprocalRankFusion([]);
    expect(result).toEqual([]);
  });

  it("fuses single list correctly", () => {
    const list = [
      { id: "a", score: 1.0 },
      { id: "b", score: 0.5 },
    ];
    const result = reciprocalRankFusion([list], 60);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("a");
    expect(result[1].id).toBe("b");
    // RRF score for rank 0 = 1/(60+1) ≈ 0.0164
    expect(result[0].score).toBeCloseTo(1 / 61, 5);
  });

  it("boosts items appearing in multiple lists", () => {
    const list1 = [
      { id: "a", score: 1.0 },
      { id: "b", score: 0.5 },
    ];
    const list2 = [
      { id: "b", score: 1.0 },
      { id: "c", score: 0.5 },
    ];
    const result = reciprocalRankFusion([list1, list2], 60);

    // "b" appears in both lists, so should have highest score
    expect(result[0].id).toBe("b");
  });

  it("uses configurable k parameter", () => {
    const list = [{ id: "a", score: 1.0 }];

    const r1 = reciprocalRankFusion([list], 10);
    const r2 = reciprocalRankFusion([list], 100);

    // Lower k = higher RRF score for top-ranked items
    expect(r1[0].score).toBeGreaterThan(r2[0].score);
  });
});

// ---- matchGlob Tests ------------------------------------------------------

describe("matchGlob", () => {
  it("matches exact path", () => {
    expect(matchGlob("src/index.ts", "src/index.ts")).toBe(true);
  });

  it("matches single wildcard", () => {
    expect(matchGlob("src/index.ts", "src/*.ts")).toBe(true);
    expect(matchGlob("src/deep/index.ts", "src/*.ts")).toBe(false);
  });

  it("matches double wildcard (recursive)", () => {
    expect(matchGlob("src/deep/index.ts", "src/**")).toBe(true);
    expect(matchGlob("src/a/b/c.ts", "src/**")).toBe(true);
  });

  it("rejects non-matching paths", () => {
    expect(matchGlob("lib/util.ts", "src/**")).toBe(false);
  });

  it("handles extension wildcard", () => {
    expect(matchGlob("src/foo.ts", "**/*.ts")).toBe(true);
    expect(matchGlob("src/foo.js", "**/*.ts")).toBe(false);
  });
});

// ---- HybridCodeSearch Tests -----------------------------------------------

describe("HybridCodeSearch", () => {
  let vectorStore: MockVectorStore;
  let symbolIndex: MockSymbolIndex;
  let embedService: MockEmbedService;
  let search: HybridCodeSearch;

  beforeEach(() => {
    vectorStore = new MockVectorStore();
    symbolIndex = new MockSymbolIndex();
    embedService = new MockEmbedService();
    search = new HybridCodeSearch(vectorStore, symbolIndex, embedService);
  });

  it("returns empty results for empty index", async () => {
    symbolIndex.symbols = [];
    const results = await search.search("query", "proj-1");
    expect(results).toEqual([]);
  });

  it("returns BM25-only results when vector search returns nothing", async () => {
    symbolIndex.symbols = [
      makeSearchableSymbol({ symbolId: "s1", name: "handleAuth" }),
      makeSearchableSymbol({ symbolId: "s2", name: "parseConfig" }),
    ];
    vectorStore.results = [];

    const results = await search.search("auth", "proj-1");

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].symbolId).toBe("s1");
  });

  it("combines BM25 and vector results with RRF", async () => {
    const s1 = makeSearchableSymbol({ symbolId: "s1", name: "authenticate" });
    const s2 = makeSearchableSymbol({ symbolId: "s2", name: "database" });
    symbolIndex.symbols = [s1, s2];

    // Vector store returns s2 as top result
    vectorStore.results = [
      {
        metadata: {
          symbolId: "s2",
          filePath: "src/server.ts",
          kind: "function",
          name: "database",
          qualifiedName: "server.database",
          contentHash: "abc",
        },
        score: 0.95,
      },
    ];

    const results = await search.search("authenticate database", "proj-1");

    // Both should appear in results
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.symbolId);
    expect(ids).toContain("s1");
    expect(ids).toContain("s2");
  });

  it("filters by file glob", async () => {
    symbolIndex.symbols = [
      makeSearchableSymbol({ symbolId: "s1", filePath: "src/auth.ts", name: "login" }),
      makeSearchableSymbol({ symbolId: "s2", filePath: "lib/utils.ts", name: "login" }),
    ];

    const results = await search.search("login", "proj-1", { fileGlob: "src/**" });

    expect(results.length).toBe(1);
    expect(results[0].filePath).toBe("src/auth.ts");
  });

  it("filters by symbol kind", async () => {
    symbolIndex.symbols = [
      makeSearchableSymbol({ symbolId: "s1", kind: "function", name: "foo" }),
      makeSearchableSymbol({ symbolId: "s2", kind: "class", name: "Foo" }),
    ];

    const results = await search.search("foo", "proj-1", { symbolKind: "class" });

    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("class");
  });

  it("respects limit option", async () => {
    symbolIndex.symbols = Array.from({ length: 50 }, (_, i) =>
      makeSearchableSymbol({ symbolId: `s${i}`, name: `fn${i}`, signature: `function fn${i}()` }),
    );

    const results = await search.search("fn", "proj-1", { limit: 5 });

    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("uses custom weights", async () => {
    const s1 = makeSearchableSymbol({ symbolId: "s1", name: "keyword_match" });
    symbolIndex.symbols = [s1];
    vectorStore.results = [
      {
        metadata: {
          symbolId: "s1",
          filePath: "src/server.ts",
          kind: "function",
          name: "keyword_match",
          qualifiedName: "m.keyword_match",
          contentHash: "x",
        },
        score: 0.9,
      },
    ];

    const results = await search.search("keyword_match", "proj-1", {
      weights: { bm25Weight: 0.8, vectorWeight: 0.2 },
    });

    expect(results.length).toBe(1);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("at vectorWeight 0, vector hits do not leak into the ranking (not even at score 0)", async () => {
    // s1 is the ONLY lexical match for "authenticate". s2 is a vector-only hit.
    // Before the fix, the RRF loop ran `fusedScores.set(id, 0 + 0)` for s2 —
    // adding nothing to its score but still INSERTING it — so s2 padded the tail
    // of a ranking the caller asked to be purely lexical.
    symbolIndex.symbols = [
      makeSearchableSymbol({ symbolId: "s1", name: "authenticate" }),
      makeSearchableSymbol({ symbolId: "s2", name: "database" }),
    ];
    vectorStore.results = [
      {
        metadata: {
          symbolId: "s2",
          filePath: "src/server.ts",
          kind: "function",
          name: "database",
          qualifiedName: "server.database",
          contentHash: "abc",
        },
        score: 0.99,
      },
    ];

    const results = await search.search("authenticate", "proj-1", {
      weights: { bm25Weight: 1, vectorWeight: 0 },
    });

    expect(results.map((r) => r.symbolId)).toEqual(["s1"]);
  });

  it("at vectorWeight 0, the embed + vector-store round-trip is skipped entirely", async () => {
    symbolIndex.symbols = [makeSearchableSymbol({ symbolId: "s1", name: "authenticate" })];
    let embedCalls = 0;
    let storeCalls = 0;
    embedService.embed = async (texts: string[]) => {
      embedCalls += 1;
      return { vectors: texts.map(() => [1, 0, 0]), model: "m", dimension: 3 };
    };
    vectorStore.search = async () => {
      storeCalls += 1;
      return [];
    };

    await search.search("authenticate", "proj-1", {
      weights: { bm25Weight: 1, vectorWeight: 0 },
    });

    expect(embedCalls).toBe(0);
    expect(storeCalls).toBe(0);
  });

  it("gracefully handles vector search failure", async () => {
    symbolIndex.symbols = [makeSearchableSymbol({ symbolId: "s1", name: "foo" })];

    // Make embed service throw
    embedService.embed = async () => {
      throw new Error("Sidecar unavailable");
    };

    const results = await search.search("foo", "proj-1");

    // Should still return BM25 results
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].symbolId).toBe("s1");
  });

  it("result includes snippet from symbol", async () => {
    symbolIndex.symbols = [
      makeSearchableSymbol({
        symbolId: "s1",
        name: "hello",
        snippet: "function hello() { ... }",
      }),
    ];

    const results = await search.search("hello", "proj-1");

    expect(results[0].snippet).toBe("function hello() { ... }");
  });

  it("default weights match exported constant", () => {
    // #807 — RE-SWEPT from #803's 0.15/0.85 on the `--wired --sweep` eval, because that
    // sweep's corpus was embedded in padded, quantized batches and every vector in it
    // was perturbed by its batch-mates (cos(batch-1, batch-64) = 0.974). Fixing the
    // embedding moves the vector channel, which makes weights derived from the old
    // vectors stale by construction — so the sweep was re-run, not merely re-read.
    //
    // These two numbers are a measured result, not a preference: see the block comment
    // on DEFAULT_WEIGHTS for the table. Changing them means re-running the sweep. So
    // does changing the EMBEDDER — that is the lesson #807 paid for.
    expect(DEFAULT_WEIGHTS.bm25Weight).toBe(0.05);
    expect(DEFAULT_WEIGHTS.vectorWeight).toBe(0.95);
    // Both channels stay live. A default that zeroes either one is not a "weighting",
    // it is a channel being switched off — and `vectorWeight: 0` is exactly the
    // pre-#797 defect (BM25-only), so it must never be reachable by default.
    expect(DEFAULT_WEIGHTS.vectorWeight).toBeGreaterThan(0);
    expect(DEFAULT_WEIGHTS.bm25Weight).toBeGreaterThan(0);
  });

  it("caches BM25 index across searches with same symbol set", async () => {
    symbolIndex.symbols = [
      makeSearchableSymbol({ symbolId: "s1", name: "alpha" }),
      makeSearchableSymbol({ symbolId: "s2", name: "beta" }),
    ];

    // Spy on BM25Index.build
    const buildSpy = vi.spyOn(BM25Index.prototype, "build");

    const search2 = new HybridCodeSearch(vectorStore, symbolIndex, embedService);

    await search2.search("alpha", "proj-1");
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Second search with same symbols — should NOT rebuild
    await search2.search("beta", "proj-1");
    expect(buildSpy).toHaveBeenCalledTimes(1);

    buildSpy.mockRestore();
  });

  it("invalidates BM25 cache when symbol set changes", async () => {
    symbolIndex.symbols = [makeSearchableSymbol({ symbolId: "s1", name: "alpha" })];

    const buildSpy = vi.spyOn(BM25Index.prototype, "build");

    const search2 = new HybridCodeSearch(vectorStore, symbolIndex, embedService);

    await search2.search("alpha", "proj-1");
    expect(buildSpy).toHaveBeenCalledTimes(1);

    // Change the symbol set
    symbolIndex.symbols = [
      makeSearchableSymbol({ symbolId: "s1", name: "alpha" }),
      makeSearchableSymbol({ symbolId: "s3", name: "gamma" }),
    ];

    await search2.search("gamma", "proj-1");
    expect(buildSpy).toHaveBeenCalledTimes(2);

    buildSpy.mockRestore();
  });
});

describe("tokenizeCode (#943 — shared query/index tokenizer)", () => {
  it("splits camelCase and PascalCase into separate lowercased terms", () => {
    expect(tokenizeCode("addItemToCart")).toEqual(["add", "item", "to", "cart"]);
    expect(tokenizeCode("HTTPServerConfig")).toEqual(["http", "server", "config"]);
  });

  it("drops single-character tokens and punctuation", () => {
    expect(tokenizeCode("a b_c, d!")).toEqual(["b_c"]);
  });

  it("returns an empty array for empty/symbol-only input", () => {
    expect(tokenizeCode("")).toEqual([]);
    expect(tokenizeCode("-- // **")).toEqual([]);
  });

  it("matches the terms BM25Index scores against (index/query parity)", () => {
    // A query preprocessed with tokenizeCode must tokenize the same way the index
    // does, so denoised queries stay in sync with the corpus (the #943 contract).
    const index = new BM25Index();
    index.build([
      {
        symbolId: "s1",
        name: "getInventoryStatus",
        qualifiedName: "svc.getInventoryStatus",
        kind: "method",
        filePath: "svc.ts",
      },
    ]);
    // "status" is a real term of the symbol; tokenizeCode surfaces it too.
    expect(tokenizeCode("getInventoryStatus")).toContain("status");
    expect(index.score("status").length).toBe(1);
  });
});

// ---- #1159 — snake_case splitting, additively -------------------------------

describe("tokenizeCode — snake_case (#1159)", () => {
  /**
   * The table from #1159's finding, run against the real exported function. Every
   * `NOT split` row in the issue is a row that must now split, and every row that
   * already split must be untouched — the camelCase behaviour is not part of this
   * change and a regression there would be invisible in the aggregate.
   */
  it.each([
    ["getUserEmail", ["get", "user", "email"]],
    ["orderStatus", ["order", "status"]],
    ["order status", ["order", "status"]],
    ["user_email_address", ["user_email_address", "user", "email", "address"]],
    ["order_status", ["order_status", "order", "status"]],
    ["project_id", ["project_id", "project", "id"]],
    ["get_user_email", ["get_user_email", "get", "user", "email"]],
    ["ORDER_STATUS", ["order_status", "order", "status"]],
  ])("tokenizes %j to %j", (input, expected) => {
    expect(tokenizeCode(input)).toEqual(expected);
  });

  it("emits the JOINED form first, so exact-name lookup keeps its highest-IDF term", () => {
    // #1159's hard constraint: pure BM25 scores exact-name-#1 at 100%. Dropping
    // `order_status` in favour of `["order","status"]` would cost that.
    expect(tokenizeCode("order_status")[0]).toBe("order_status");
  });

  it("makes the NL query 'order status' reach a snake_case symbol at all", () => {
    // Before #1159 these two token sets were disjoint — not a weak match, no match.
    const query = new Set(tokenizeCode("order status"));
    expect(tokenizeCode("order_status").some((t) => query.has(t))).toBe(true);
  });

  it("keeps the single-character rule, so `a_b` contributes only its joined form", () => {
    // #1159 scope item 2: changing `length > 1` is a separate claim needing its own
    // number. `id` (length 2) survives; `a` and `b` do not.
    expect(tokenizeCode("a_b")).toEqual(["a_b"]);
    expect(tokenizeCode("project_id")).toContain("id");
  });

  it("does not emit empty parts for leading/trailing/repeated underscores", () => {
    expect(tokenizeCode("__init__")).toEqual(["__init__", "init"]);
    expect(tokenizeCode("___")).toEqual(["___"]);
    expect(tokenizeCode("_leading")).toEqual(["_leading", "leading"]);
  });

  /**
   * The round-trip property the #943 query-side consumer depends on. `tokenizeCode`
   * is deliberately NOT idempotent under join-and-retokenize (it emits parts a second
   * time), so a caller that rebuilds a query string must go through
   * `tokenizeCodeRoots`. This asserts that route is exact rather than approximately
   * right — a doubled query term is a silent re-weighting, not a visible failure.
   */
  it.each([
    "order_status",
    "the order_status of a purchase",
    "getUserEmail and user_email_address",
    "__init__ project_id ORDER_STATUS",
    "no underscores here at all",
    "",
  ])("re-tokenizing the joined ROOTS of %j reproduces the full token list", (input) => {
    expect(tokenizeCode(tokenizeCodeRoots(input).join(" "))).toEqual(tokenizeCode(input));
  });

  it("joining the FULL token list instead would double the derived parts", () => {
    // The hazard `tokenizeCodeRoots` exists to remove, stated as a test so the
    // reason for that export cannot be refactored away as redundant.
    expect(tokenizeCode(tokenizeCode("order_status").join(" "))).toEqual([
      "order_status",
      "order",
      "status",
      "order",
      "status",
    ]);
  });

  it("splits a snake_case term that camelCase expansion produced", () => {
    // `Order_Status` hits neither camel rule but must still split on the underscore.
    expect(tokenizeCode("Order_Status")).toEqual(["order_status", "order", "status"]);
  });

  it("retrieves a snake_case symbol from an NL requirement through BM25", () => {
    const index = new BM25Index();
    index.build([
      {
        symbolId: "t1",
        name: "order_status",
        qualifiedName: "public.order_status",
        kind: "table",
        filePath: "schema.prisma",
      },
      {
        symbolId: "t2",
        name: "shipping_label",
        qualifiedName: "public.shipping_label",
        kind: "table",
        filePath: "schema.prisma",
      },
    ]);
    const results = index.score("the order status of a purchase");
    expect(results[0]?.symbolId).toBe("t1");
  });

  it("still ranks the exact snake_case name #1 against a near neighbour", () => {
    const index = new BM25Index();
    index.build([
      {
        symbolId: "t1",
        name: "order_status",
        qualifiedName: "public.order_status",
        kind: "table",
        filePath: "schema.prisma",
      },
      {
        symbolId: "t2",
        name: "order_status_history",
        qualifiedName: "public.order_status_history",
        kind: "table",
        filePath: "schema.prisma",
      },
    ]);
    expect(index.score("order_status")[0]?.symbolId).toBe("t1");
  });
});

describe("LexicalConfig — the index/query tokenization contract (#943, #1159)", () => {
  const symbol: SearchableSymbol = {
    symbolId: "s1",
    name: "workspace_members",
    qualifiedName: "public.workspace_members",
    kind: "table",
    filePath: "db/schema.prisma",
  };

  it("defaults to production's tokenizer and document builder", () => {
    expect(DEFAULT_LEXICAL_CONFIG.tokenizer).toBe(tokenizeCode);
    expect(DEFAULT_LEXICAL_CONFIG.buildDocumentText).toBe(buildSymbolDocumentText);
  });

  /**
   * The #943 contract, asserted as a PROPERTY rather than as a pair of literals:
   * `BM25Index` must score a query with the SAME function it indexed with, so an
   * arbitrary alternative tokenizer desyncs neither side. A test comparing two
   * hard-coded token lists would pass while the two sides drifted together.
   */
  it("scores a query with the same tokenizer it indexed with", () => {
    const seen: string[] = [];
    const spying = (text: string): string[] => {
      seen.push(text);
      return tokenizeCode(text);
    };
    const index = new BM25Index({
      tokenizer: spying,
      buildDocumentText: buildSymbolDocumentText,
    });
    index.build([symbol]);
    const indexSideCalls = seen.length;
    expect(indexSideCalls).toBeGreaterThan(0);

    index.score("workspace members");
    // The query went through the SAME injected function, not through `tokenizeCode`.
    expect(seen.length).toBe(indexSideCalls + 1);
    expect(seen[seen.length - 1]).toBe("workspace members");
  });

  it("desyncs nothing when a caller supplies a non-default tokenizer", () => {
    // A tokenizer that splits on "-" only. Index and query both see it, so a
    // hyphenated query still retrieves a hyphenated document.
    const hyphen = (t: string): string[] =>
      t
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const index = new BM25Index({ tokenizer: hyphen, buildDocumentText: buildSymbolDocumentText });
    index.build([{ ...symbol, name: "alpha-beta", qualifiedName: "x.alpha-beta" }]);
    expect(index.score("beta").length).toBe(1);
  });

  it("HybridCodeSearch routes its lexical config into the BM25 index", async () => {
    const index = new MockSymbolIndex();
    index.symbols = [symbol];
    const calls: string[] = [];
    const search = new HybridCodeSearch(new MockVectorStore(), index, new MockEmbedService(), {
      tokenizer: (t) => {
        calls.push(t);
        return tokenizeCode(t);
      },
      buildDocumentText: buildSymbolDocumentText,
    });
    await search.search("workspace members", "proj-1", {
      weights: { bm25Weight: 1, vectorWeight: 0 },
    });
    expect(calls).toContain("workspace members");
  });
});

describe("buildSymbolDocumentText (#1159 — what production BM25 can actually see)", () => {
  it("joins only the fields a production `CodeSymbol` row carries", () => {
    // `SYMBOL_SELECT` in project-code-searcher.ts reads id/name/qualifiedName/kind/
    // filePath. `signature` and `docstring` exist on the TYPE but have no column, so
    // a document text that depends on them is unreachable in production.
    expect(
      buildSymbolDocumentText({
        symbolId: "s1",
        name: "handleRequest",
        qualifiedName: "server.handleRequest",
        kind: "function",
        filePath: "src/server.ts",
      }),
    ).toBe("handleRequest server.handleRequest");
  });

  it("appends signature and docstring only when a caller supplies them", () => {
    expect(buildSymbolDocumentText(makeSearchableSymbol())).toContain(
      "Handles an incoming HTTP request.",
    );
  });
});
