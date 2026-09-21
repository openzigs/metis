/**
 * Epic #1156 / Issue #1159 — unit tests for the lexical A/B.
 *
 * No weights, no network, no store: every arm here is driven by an injected searcher.
 */
import { describe, it, expect } from "vitest";
import {
  assertProductionReachableFields,
  compareLexicalArm,
  createLexicalArmSearch,
  describeArmDocuments,
  enrichedDocumentText,
  excludeQueries,
  legacyTokenizeCode,
  LEXICAL_ARMS,
  LEXICAL_K,
  MIN_IMPORTANT_BM25_DELTA,
  MIN_IMPORTANT_FUSED_DELTA,
  renderLexicalArms,
  renderLexicalDecision,
  renderSnakeStratum,
  scoreLexicalArm,
  SNAKE_UPPER_BOUND_QUERY_IDS,
  summariseSnakeStratum,
  underscoreSymbolShare,
  type LexicalArmResult,
  type LexicalSearch,
} from "./lexical-ab.js";
import {
  buildSymbolDocumentText,
  tokenizeCode,
  type SearchableSymbol,
} from "../../code-graph/hybrid-search.js";
import type { EmbedRetrievalCorpus } from "./corpus.js";
import type { QueryScore } from "./metrics.js";

// ---- Fixtures ---------------------------------------------------------------

function symbol(overrides: Partial<SearchableSymbol> = {}): SearchableSymbol {
  return {
    symbolId: "s1",
    name: "order_status",
    qualifiedName: "public.order_status",
    kind: "table",
    filePath: "db/schema.prisma",
    language: "sql",
    ...overrides,
  };
}

/** A corpus just rich enough for the arm scorer and the exact-name probes. */
function corpus(overrides: Partial<EmbedRetrievalCorpus> = {}): EmbedRetrievalCorpus {
  const symbols = [
    {
      id: "s1",
      projectId: "p",
      kind: "table",
      name: "order_status",
      qualifiedName: "public.order_status",
      filePath: "db/schema.prisma",
      startLine: 1,
      endLine: 1,
      language: "sql",
    },
    {
      id: "s2",
      projectId: "p",
      kind: "function",
      name: "handleRequest",
      qualifiedName: "server.handleRequest",
      filePath: "src/server.ts",
      startLine: 1,
      endLine: 1,
      language: "ts",
    },
  ];
  return {
    spec: {
      id: "test-corpus",
      title: "t",
      snapshotCommit: "0".repeat(40),
      groundTruth: "g",
      queries: [],
    },
    projectId: "p",
    symbols: symbols as EmbedRetrievalCorpus["symbols"],
    docs: [],
    queries: [
      { id: "Q1", requirement: "the order status of a purchase", relevant: ["s1"], strata: null },
      { id: "Q2", requirement: "handle an incoming request", relevant: ["s2"], strata: null },
    ],
    searchable: symbols.map((s) => ({
      symbolId: s.id,
      name: s.name,
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      filePath: s.filePath,
      language: s.language,
    })),
    ...overrides,
  };
}

/** A searcher that returns a fixed ranking per query string. */
function fixedSearch(byQuery: Record<string, string[]>): LexicalSearch {
  return async (query, limit) => (byQuery[query] ?? []).slice(0, limit);
}

function armResult(overrides: Partial<LexicalArmResult> = {}): LexicalArmResult {
  const perQuery: QueryScore[] = [
    {
      queryId: "Q1",
      ranked: ["s1"],
      relevant: ["s1"],
      firstRelevantRank: 1,
      recallAtK: { 10: 1 },
      reciprocalRank: 1,
      ndcgAtK: { 10: 1 },
    },
  ];
  return {
    armId: "arm",
    label: "arm",
    ndcg10: 1,
    ndcg10Ci: {
      mean: 1,
      ciLow: 1,
      ciHigh: 1,
      halfWidth: 0,
      sd: 0,
      n: 1,
      confidence: 0.95,
      resamples: 20000,
      zeroFraction: 0,
    },
    mrr: 1,
    perQuery,
    exactNameTop1: 1,
    exactNameCount: 1,
    exactNameMisses: [],
    ...overrides,
  };
}

/** Build per-query scores directly, for the paired-comparison tests. */
function scores(values: Record<string, number>): QueryScore[] {
  return Object.entries(values).map(([queryId, v]) => ({
    queryId,
    ranked: [],
    relevant: ["x"],
    firstRelevantRank: v > 0 ? 1 : null,
    recallAtK: { 10: v },
    reciprocalRank: v,
    ndcgAtK: { [LEXICAL_K]: v },
  }));
}

// ---- The frozen baseline ----------------------------------------------------

describe("legacyTokenizeCode — the frozen pre-#1159 production tokenizer", () => {
  /**
   * #1159's finding table, verbatim. This is the ground truth for what the function
   * USED to do, so a baseline arm that fails it is measuring against the wrong thing —
   * and every delta this issue reports would be wrong with it.
   */
  it.each([
    ["getUserEmail", ["get", "user", "email"]],
    ["orderStatus", ["order", "status"]],
    ["order status", ["order", "status"]],
    ["user_email_address", ["user_email_address"]],
    ["order_status", ["order_status"]],
    ["project_id", ["project_id"]],
    ["get_user_email", ["get_user_email"]],
    ["ORDER_STATUS", ["order_status"]],
  ])("tokenizes %j to %j — exactly as production did at bb86b146", (input, expected) => {
    expect(legacyTokenizeCode(input)).toEqual(expected);
  });

  it("is NOT the production tokenizer — that is the whole point of the comparison", () => {
    expect(legacyTokenizeCode("order_status")).not.toEqual(tokenizeCode("order_status"));
  });

  it("agrees with production wherever no underscore is involved", () => {
    for (const input of ["getUserEmail", "HTTPServerConfig", "the quick brown fox", "", "-- //"]) {
      expect(legacyTokenizeCode(input)).toEqual(tokenizeCode(input));
    }
  });
});

// ---- Arms -------------------------------------------------------------------

describe("LEXICAL_ARMS", () => {
  it("isolates each lever: exactly one arm varies one thing from the baseline", () => {
    const byId = Object.fromEntries(LEXICAL_ARMS.map((a) => [a.id, a.config]));
    expect(byId.baseline.tokenizer).toBe(legacyTokenizeCode);
    expect(byId.baseline.buildDocumentText).toBe(buildSymbolDocumentText);
    // lever 1 changes ONLY the tokenizer
    expect(byId.tokenizer.tokenizer).toBe(tokenizeCode);
    expect(byId.tokenizer.buildDocumentText).toBe(byId.baseline.buildDocumentText);
    // lever 2 changes ONLY the document
    expect(byId.document.tokenizer).toBe(byId.baseline.tokenizer);
    expect(byId.document.buildDocumentText).toBe(enrichedDocumentText);
    // combined changes both
    expect(byId.combined.tokenizer).toBe(tokenizeCode);
    expect(byId.combined.buildDocumentText).toBe(enrichedDocumentText);
  });

  it("names the four arms the report expects", () => {
    expect(LEXICAL_ARMS.map((a) => a.id)).toEqual([
      "baseline",
      "tokenizer",
      "document",
      "combined",
    ]);
  });
});

describe("enrichedDocumentText (lever 2)", () => {
  it("adds only fields a production CodeSymbol row can supply", () => {
    expect(enrichedDocumentText(symbol())).toBe(
      "order_status public.order_status db/schema.prisma table sql",
    );
  });

  it("omits language when the symbol carries none, rather than emitting undefined", () => {
    expect(enrichedDocumentText(symbol({ language: undefined }))).toBe(
      "order_status public.order_status db/schema.prisma table",
    );
  });

  it("is a strict superset of the shipped document text", () => {
    const sym = symbol();
    expect(enrichedDocumentText(sym).startsWith(buildSymbolDocumentText(sym))).toBe(true);
  });

  it("makes filePath segments retrievable once tokenized", () => {
    expect(
      tokenizeCode(enrichedDocumentText(symbol({ filePath: "finops/budget-enforcer.ts" }))),
    ).toEqual(expect.arrayContaining(["finops", "budget", "enforcer", "ts"]));
  });
});

describe("describeArmDocuments", () => {
  it("shows the baseline arm indexing name + qualifiedName and nothing else", () => {
    const rows = describeArmDocuments(symbol());
    const baseline = rows.find((r) => r.armId === "baseline");
    expect(baseline?.documentText).toBe("order_status public.order_status");
    // The baseline tokenizer leaves the snake_case name whole — the defect itself.
    expect(baseline?.terms).toEqual(["order_status", "public", "order_status"]);
  });

  it("shows the tokenizer arm splitting the same document", () => {
    const rows = describeArmDocuments(symbol());
    expect(rows.find((r) => r.armId === "tokenizer")?.terms).toEqual([
      "order_status",
      "order",
      "status",
      "public",
      "order_status",
      "order",
      "status",
    ]);
  });
});

// ---- Scoring ----------------------------------------------------------------

describe("scoreLexicalArm", () => {
  it("scores every query and runs the exact-name suite, naming its misses", async () => {
    const c = corpus();
    const search = fixedSearch({
      "the order status of a purchase": ["s1"],
      "handle an incoming request": ["s2"],
      // exact-name probes, one hit and one miss
      order_status: ["s1"],
      handleRequest: ["s1", "s2"],
    });
    const arm = await scoreLexicalArm(c, search, { id: "a", label: "A" });

    expect(arm.ndcg10).toBe(1);
    expect(arm.mrr).toBe(1);
    expect(arm.exactNameCount).toBe(2);
    expect(arm.exactNameTop1).toBe(0.5);
    // The MISS SET, by name — #1159's hard stop is stated on the set, not the count.
    expect(arm.exactNameMisses).toEqual(["handleRequest"]);
  });

  it("carries per-query scores so a paired comparison is possible", async () => {
    const arm = await scoreLexicalArm(corpus(), fixedSearch({}), { id: "a", label: "A" });
    expect(arm.perQuery.map((q) => q.queryId)).toEqual(["Q1", "Q2"]);
    expect(arm.ndcg10).toBe(0);
  });

  it("reports 0, not NaN, when the corpus yields no exact-name probes", async () => {
    // Every ground-truth name is shared by two symbols, so `exactNameProbes` drops
    // them all — "rank #1" is not well defined when two symbols answer equally well.
    const c = corpus();
    const ambiguous = {
      ...c,
      symbols: [
        ...c.symbols,
        { ...c.symbols[0], id: "s1b" },
        { ...c.symbols[1], id: "s2b" },
      ] as EmbedRetrievalCorpus["symbols"],
    };
    const arm = await scoreLexicalArm(ambiguous, fixedSearch({}), { id: "a", label: "A" });
    expect(arm.exactNameCount).toBe(0);
    expect(arm.exactNameTop1).toBe(0);
  });

  it("reports 0, not NaN, for a corpus with no queries at all", async () => {
    const arm = await scoreLexicalArm(corpus({ queries: [] }), fixedSearch({}), {
      id: "a",
      label: "A",
    });
    expect(arm.ndcg10).toBe(0);
    expect(arm.mrr).toBe(0);
  });
});

// ---- Comparison -------------------------------------------------------------

describe("compareLexicalArm", () => {
  it("reports the paired CI, the sign test, and the NON-ZERO delta count", () => {
    const baseline = armResult({ armId: "baseline", perQuery: scores({ Q1: 0, Q2: 0, Q3: 0.5 }) });
    const arm = armResult({ armId: "tokenizer", perQuery: scores({ Q1: 1, Q2: 0, Q3: 0.5 }) });
    const cmp = compareLexicalArm(baseline, arm, MIN_IMPORTANT_BM25_DELTA);

    expect(cmp.paired.n).toBe(3);
    expect(cmp.paired.wins).toBe(1);
    expect(cmp.paired.ties).toBe(2);
    // Only ONE query moved — the bootstrap's effective sample, reported as a column.
    expect(cmp.nonZeroDeltas).toBe(1);
    expect(cmp.pairedSd).toBeGreaterThan(0);
    expect(cmp.minDelta).toBe(MIN_IMPORTANT_BM25_DELTA);
  });

  it("classifies a flat comparison as NOT-ESTABLISHED", () => {
    const same = scores({ Q1: 0.5, Q2: 0.5, Q3: 0.5 });
    const cmp = compareLexicalArm(
      armResult({ armId: "baseline", perQuery: same }),
      armResult({ armId: "document", perQuery: scores({ Q1: 0.5, Q2: 0.5, Q3: 0.5 }) }),
      MIN_IMPORTANT_BM25_DELTA,
    );
    expect(cmp.paired.meanDelta).toBe(0);
    expect(cmp.verdict).toBe("NOT-ESTABLISHED");
  });

  it("reports DIRECTION-ESTABLISHED-MAGNITUDE-NOT when the CI clears zero but not the bar", () => {
    // A uniform +0.03 on every query: the CI is degenerate at +0.03, which excludes
    // zero but sits below the +0.05 pre-registered bar.
    const base: Record<string, number> = {};
    const cand: Record<string, number> = {};
    for (let i = 0; i < 30; i += 1) {
      base[`Q${i}`] = 0.2;
      cand[`Q${i}`] = 0.23;
    }
    const cmp = compareLexicalArm(
      armResult({ armId: "baseline", perQuery: scores(base) }),
      armResult({ armId: "tokenizer", perQuery: scores(cand) }),
      MIN_IMPORTANT_BM25_DELTA,
    );
    expect(cmp.verdict).toBe("DIRECTION-ESTABLISHED-MAGNITUDE-NOT");
  });

  it("reports SHIP only when the CI's LOWER bound clears the pre-registered bar", () => {
    const base: Record<string, number> = {};
    const cand: Record<string, number> = {};
    for (let i = 0; i < 30; i += 1) {
      base[`Q${i}`] = 0.2;
      cand[`Q${i}`] = 0.5; // +0.30 uniformly, well clear of +0.05
    }
    const cmp = compareLexicalArm(
      armResult({ armId: "baseline", perQuery: scores(base) }),
      armResult({ armId: "tokenizer", perQuery: scores(cand) }),
      MIN_IMPORTANT_BM25_DELTA,
    );
    expect(cmp.verdict).toBe("SHIP");
    expect(cmp.testsAgree).toBe(true);
  });

  it("ignores a query only one arm scored, rather than borrowing the other's value", () => {
    // `compareArms` already pairs on query id; this pins the SAME rule for the
    // delta vector `pairedSd` and `nonZeroDeltas` are computed from, which is a
    // second, independent traversal in this module.
    const cmp = compareLexicalArm(
      armResult({ armId: "baseline", perQuery: scores({ Q1: 0.2, Q2: 0.4 }) }),
      armResult({ armId: "tokenizer", perQuery: scores({ Q1: 0.6, Q3: 1 }) }),
      MIN_IMPORTANT_BM25_DELTA,
    );
    expect(cmp.paired.n).toBe(1);
    expect(cmp.nonZeroDeltas).toBe(1);
    expect(cmp.pairedSd).toBe(0); // one observation carries no spread
  });

  it("treats a per-query score missing the @10 cut-off as 0 rather than NaN", () => {
    const missing = armResult({
      armId: "tokenizer",
      perQuery: [
        {
          queryId: "Q1",
          ranked: [],
          relevant: ["x"],
          firstRelevantRank: null,
          recallAtK: {},
          reciprocalRank: 0,
          ndcgAtK: {}, // no `10` key at all
        },
      ],
    });
    const cmp = compareLexicalArm(
      armResult({ armId: "baseline", perQuery: scores({ Q1: 0 }) }),
      missing,
      MIN_IMPORTANT_BM25_DELTA,
    );
    expect(cmp.paired.meanDelta).toBe(0);
    expect(summariseSnakeStratum(missing, new Set(["Q1"])).allNdcg10).toBe(0);
  });

  it("surfaces a miss-set change by NAME even when the count is unchanged", () => {
    const cmp = compareLexicalArm(
      armResult({ armId: "baseline", exactNameMisses: ["getEmbedder"] }),
      armResult({ armId: "tokenizer", exactNameMisses: ["parseBudget"] }),
      MIN_IMPORTANT_BM25_DELTA,
    );
    expect(cmp.missSet.identical).toBe(false);
    expect(cmp.missSet.regressed).toEqual(["parseBudget"]);
    expect(cmp.missSet.recovered).toEqual(["getEmbedder"]);
  });

  it("judges the fused channel against its own, smaller pre-registered bar", () => {
    const base: Record<string, number> = {};
    const cand: Record<string, number> = {};
    for (let i = 0; i < 30; i += 1) {
      base[`Q${i}`] = 0.2;
      cand[`Q${i}`] = 0.23; // +0.03: below the BM25 bar, above the fused one
    }
    const a = armResult({ armId: "baseline", perQuery: scores(base) });
    const b = armResult({ armId: "combined", perQuery: scores(cand) });
    expect(compareLexicalArm(a, b, MIN_IMPORTANT_BM25_DELTA).verdict).toBe(
      "DIRECTION-ESTABLISHED-MAGNITUDE-NOT",
    );
    expect(compareLexicalArm(a, b, MIN_IMPORTANT_FUSED_DELTA).verdict).toBe("SHIP");
  });
});

// ---- The decision statistic without the flattered queries --------------------

describe("excludeQueries", () => {
  it("drops the named queries and recomputes nDCG@10 and MRR over the survivors", () => {
    const arm = armResult({
      armId: "tokenizer",
      perQuery: scores({ Q1: 0, Q2: 0, Q113: 1, Q114: 1 }),
      ndcg10: 0.5,
      mrr: 0.5,
    });
    const clean = excludeQueries(arm, ["Q113", "Q114"]);

    expect(clean.perQuery.map((q) => q.queryId)).toEqual(["Q1", "Q2"]);
    // The whole point: the aggregate is RE-derived from the survivors, not carried
    // over from the full set. Carrying it over is exactly the flattering that this
    // function exists to undo.
    expect(clean.ndcg10).toBe(0);
    expect(clean.mrr).toBe(0);
    expect(clean.ndcg10Ci.n).toBe(2);
  });

  it("carries the exact-name probe fields through UNCHANGED", () => {
    // The exact-name suite is keyed by SYMBOL NAME and runs outside `corpus.queries`,
    // so excluding a corpus query cannot move it. Recomputing it here would invent a
    // number, and #1159's hard stop is read off this field.
    const arm = armResult({
      armId: "tokenizer",
      perQuery: scores({ Q1: 1, Q113: 1 }),
      exactNameTop1: 0.76,
      exactNameCount: 155,
      exactNameMisses: ["extract_usage"],
    });
    const clean = excludeQueries(arm, ["Q113"]);

    expect(clean.exactNameTop1).toBe(0.76);
    expect(clean.exactNameCount).toBe(155);
    expect(clean.exactNameMisses).toEqual(["extract_usage"]);
  });

  it("keeps the arm id and label so the rendered row still names the arm", () => {
    const clean = excludeQueries(
      armResult({ armId: "tokenizer", label: "lever 1", perQuery: scores({ Q1: 1, Q113: 1 }) }),
      ["Q113"],
    );
    expect(clean.armId).toBe("tokenizer");
    expect(clean.label).toBe("lever 1");
  });

  it("returns 0, not NaN, when every query is excluded", () => {
    const clean = excludeQueries(armResult({ perQuery: scores({ Q113: 1 }) }), ["Q113"]);
    expect(clean.perQuery).toEqual([]);
    expect(clean.ndcg10).toBe(0);
    expect(clean.mrr).toBe(0);
  });

  it("treats a SURVIVING query missing the @10 cut-off as 0 rather than NaN", () => {
    // Same rule `scoreLexicalArm` and `summariseSnakeStratum` apply; pinned here because
    // one NaN survivor would poison the recomputed aggregate AND its CI silently.
    const arm = armResult({
      perQuery: [
        {
          queryId: "Q1",
          ranked: [],
          relevant: ["x"],
          firstRelevantRank: null,
          recallAtK: {},
          reciprocalRank: 0,
          ndcgAtK: {}, // no `10` key at all
        },
        ...scores({ Q113: 1 }),
      ],
    });
    const clean = excludeQueries(arm, ["Q113"]);
    expect(clean.ndcg10).toBe(0);
    expect(Number.isNaN(clean.ndcg10)).toBe(false);
    expect(clean.ndcg10Ci.mean).toBe(0);
  });

  it("is a no-op for an empty exclusion list and for an id the arm never scored", () => {
    const arm = armResult({ perQuery: scores({ Q1: 0.25, Q2: 0.75 }) });
    expect(excludeQueries(arm, []).perQuery).toHaveLength(2);
    expect(excludeQueries(arm, ["Q999"]).perQuery).toHaveLength(2);
    expect(excludeQueries(arm, []).ndcg10).toBeCloseTo(0.5, 10);
  });

  it("does not mutate the arm it was handed", () => {
    const arm = armResult({ perQuery: scores({ Q1: 1, Q113: 1 }) });
    excludeQueries(arm, ["Q113"]);
    expect(arm.perQuery).toHaveLength(2);
    expect(arm.ndcg10).toBe(1);
  });

  it("defaults to the five upper-bound queries, so the caller cannot pick a flattering set", () => {
    const arm = armResult({
      perQuery: scores({ Q1: 0, Q113: 1, Q114: 1, Q116: 1, Q117: 1, Q118: 1 }),
    });
    expect(excludeQueries(arm).perQuery.map((q) => q.queryId)).toEqual(["Q1"]);
    expect(SNAKE_UPPER_BOUND_QUERY_IDS).toHaveLength(5);
  });

  /**
   * The finding this function was added for (PR #1177 review): the aggregate delta,
   * the paired CI and the sign test were only ever reported on the full 127, while
   * the disclosed upper-bound queries were among the movers. Feeding both arms
   * through `excludeQueries` re-derives the DECISION statistic on the clean subset.
   */
  it("re-derives the decision statistic, degrading a verdict carried by excluded queries", () => {
    const base: Record<string, number> = {};
    const cand: Record<string, number> = {};
    for (let i = 0; i < 30; i += 1) {
      base[`Q${i}`] = 0.2;
      cand[`Q${i}`] = 0.2; // 30 ties
    }
    // Every win sits in the five upper-bound queries.
    for (const id of SNAKE_UPPER_BOUND_QUERY_IDS) {
      base[id] = 0;
      cand[id] = 1;
    }
    const baseline = armResult({ armId: "baseline", perQuery: scores(base) });
    const arm = armResult({ armId: "tokenizer", perQuery: scores(cand) });

    const full = compareLexicalArm(baseline, arm, MIN_IMPORTANT_BM25_DELTA);
    expect(full.paired.wins).toBe(5);
    expect(full.paired.meanDelta).toBeGreaterThan(0);

    const clean = compareLexicalArm(
      excludeQueries(baseline),
      excludeQueries(arm),
      MIN_IMPORTANT_BM25_DELTA,
    );
    expect(clean.paired.n).toBe(30);
    expect(clean.paired.wins).toBe(0);
    expect(clean.paired.meanDelta).toBe(0);
    expect(clean.verdict).toBe("NOT-ESTABLISHED");
  });
});

// ---- The snake stratum, honestly --------------------------------------------

describe("summariseSnakeStratum", () => {
  const snakeIds = new Set(["Q113", "Q114", "Q116", "Q117", "Q118", "Q101", "Q102"]);

  it("reports the stratum with AND without the five upper-bound queries", () => {
    const arm = armResult({
      perQuery: scores({
        // The five that carry the table's words verbatim — all perfect.
        Q113: 1,
        Q114: 1,
        Q116: 1,
        Q117: 1,
        Q118: 1,
        // The rest of the stratum — all zero.
        Q101: 0,
        Q102: 0,
        // Not in the stratum at all.
        Q001: 1,
      }),
    });
    const s = summariseSnakeStratum(arm, snakeIds);

    expect(s.allQueries).toBe(7);
    expect(s.allNdcg10).toBeCloseTo(5 / 7, 6);
    // The number a reader should actually act on.
    expect(s.cleanQueries).toBe(2);
    expect(s.cleanNdcg10).toBe(0);
    // And the flattering one, printed so the gap is visible.
    expect(s.upperBoundQueries).toBe(5);
    expect(s.upperBoundNdcg10).toBe(1);
  });

  it("excludes queries outside the stratum from every column", () => {
    const arm = armResult({ perQuery: scores({ Q101: 0.5, Q999: 1 }) });
    const s = summariseSnakeStratum(arm, snakeIds);
    expect(s.allQueries).toBe(1);
    expect(s.allNdcg10).toBe(0.5);
  });

  it("names the five queries #1157 and #1158 disclosed", () => {
    expect([...SNAKE_UPPER_BOUND_QUERY_IDS]).toEqual(["Q113", "Q114", "Q116", "Q117", "Q118"]);
  });
});

// ---- Corpus honesty guards --------------------------------------------------

describe("assertProductionReachableFields", () => {
  it("passes on a corpus whose searchable view matches SYMBOL_SELECT", () => {
    expect(() => assertProductionReachableFields(corpus())).not.toThrow();
  });

  it("throws when the corpus populates a field production cannot supply", () => {
    const c = corpus();
    const flattering = {
      ...c,
      searchable: c.searchable.map((s) => ({ ...s, docstring: "a helpful description" })),
    };
    expect(() => assertProductionReachableFields(flattering)).toThrow(/unreachable in production/);
  });
});

describe("underscoreSymbolShare", () => {
  it("reports how much of the index the tokenizer change can reach at all", () => {
    const s = underscoreSymbolShare(corpus());
    expect(s).toEqual({ withUnderscore: 1, total: 2, share: 0.5 });
  });

  it("returns a zero share rather than NaN for an empty corpus", () => {
    expect(underscoreSymbolShare(corpus({ searchable: [] })).share).toBe(0);
  });
});

// ---- The arm searcher -------------------------------------------------------

describe("createLexicalArmSearch", () => {
  const deps = {
    vectorStore: {
      async search() {
        return [];
      },
    },
    symbolIndex: {
      async getSymbols() {
        return corpus().searchable;
      },
    },
    embedService: {
      async embed() {
        throw new Error("no embedder in this test");
      },
    },
    projectId: "p",
    weights: { bm25Weight: 1, vectorWeight: 0 },
  };

  it("retrieves a snake_case symbol under the tokenizer arm and not under the baseline", async () => {
    const byId = Object.fromEntries(LEXICAL_ARMS.map((a) => [a.id, a.config]));
    const query = "the order status of a purchase";

    const baseline = createLexicalArmSearch(deps, byId.baseline);
    const tokenizer = createLexicalArmSearch(deps, byId.tokenizer);

    // The defect itself: no term in common, so BM25 scores nothing at all.
    expect(await baseline(query, LEXICAL_K)).toEqual([]);
    // The fix, measured through the production searcher.
    expect(await tokenizer(query, LEXICAL_K)).toEqual(["s1"]);
  });

  it("still ranks the exact snake_case name #1 under the tokenizer arm", async () => {
    const byId = Object.fromEntries(LEXICAL_ARMS.map((a) => [a.id, a.config]));
    const tokenizer = createLexicalArmSearch(deps, byId.tokenizer);
    expect((await tokenizer("order_status", LEXICAL_K))[0]).toBe("s1");
  });

  it("reaches no embedder at vectorWeight 0, so the pure-BM25 arm needs no weights", async () => {
    const byId = Object.fromEntries(LEXICAL_ARMS.map((a) => [a.id, a.config]));
    // `deps.embedService` throws; `HybridCodeSearch` skips the vector branch entirely
    // at `vectorWeight: 0`, so this resolves rather than falling into the catch.
    await expect(
      createLexicalArmSearch(deps, byId.combined)("order status", LEXICAL_K),
    ).resolves.toBeInstanceOf(Array);
  });
});

// ---- Rendering --------------------------------------------------------------

describe("renderers", () => {
  it("renders the arm table with the miss set spelled out", () => {
    const baseline = armResult({ armId: "baseline", label: "b", exactNameMisses: ["a"] });
    const arm = armResult({ armId: "tokenizer", label: "t", exactNameMisses: ["b"] });
    const cmp = compareLexicalArm(baseline, arm, MIN_IMPORTANT_BM25_DELTA);
    const md = renderLexicalArms(baseline, [arm], [cmp]);
    expect(md).toContain("`baseline`");
    expect(md).toContain("lost b");
    expect(md).toContain("recovered a");
  });

  it("renders the decision table with the bar and the verdict", () => {
    const cmp = compareLexicalArm(
      armResult({ armId: "baseline", perQuery: scores({ Q1: 0 }) }),
      armResult({ armId: "tokenizer", perQuery: scores({ Q1: 0 }) }),
      MIN_IMPORTANT_BM25_DELTA,
    );
    const md = renderLexicalDecision([cmp]);
    expect(md).toContain("+0.050");
    expect(md).toContain("NOT-ESTABLISHED");
  });

  it("prints `identical` when the miss set did not move", () => {
    const baseline = armResult({ armId: "baseline", exactNameMisses: ["a"] });
    const arm = armResult({ armId: "tokenizer", exactNameMisses: ["a"] });
    const cmp = compareLexicalArm(baseline, arm, MIN_IMPORTANT_BM25_DELTA);
    expect(renderLexicalArms(baseline, [arm], [cmp])).toContain("identical");
  });

  it("prints only the half of the miss delta that actually moved", () => {
    const baseline = armResult({ armId: "baseline", exactNameMisses: [] });
    const regressedOnly = armResult({ armId: "document", exactNameMisses: ["testConnection"] });
    const md = renderLexicalArms(
      baseline,
      [regressedOnly],
      [compareLexicalArm(baseline, regressedOnly, MIN_IMPORTANT_BM25_DELTA)],
    );
    expect(md).toContain("lost testConnection");
    expect(md).not.toContain("recovered");

    const recoveredOnly = armResult({ armId: "tokenizer", exactNameMisses: [] });
    const md2 = renderLexicalArms(
      regressedOnly,
      [recoveredOnly],
      [compareLexicalArm(regressedOnly, recoveredOnly, MIN_IMPORTANT_BM25_DELTA)],
    );
    expect(md2).toContain("recovered testConnection");
    expect(md2).not.toContain("lost ");
  });

  it("renders an arm with no comparison row as a bare dash", () => {
    const baseline = armResult({ armId: "baseline" });
    expect(renderLexicalArms(baseline, [], [])).toContain("| — |");
  });

  it("renders a NEGATIVE delta without a leading plus, and flags disagreeing tests", () => {
    // A single-query comparison: the bootstrap resamples one value, so the CI is
    // degenerate and excludes zero while the sign test cannot reject at n=1.
    const cmp = compareLexicalArm(
      armResult({ armId: "baseline", perQuery: scores({ Q1: 0.9 }) }),
      armResult({ armId: "document", perQuery: scores({ Q1: 0.1 }) }),
      MIN_IMPORTANT_BM25_DELTA,
    );
    const md = renderLexicalDecision([cmp]);
    expect(md).toContain("| -0.800 |");
    expect(cmp.testsAgree).toBe(false);
    expect(md).toContain("**NO — sign test wins**");
    // The sign test wins on disagreement, so this cannot read as an established effect.
    expect(cmp.verdict).toBe("NOT-ESTABLISHED");
  });

  it("renders the snake stratum three ways", () => {
    const md = renderSnakeStratum([
      summariseSnakeStratum(
        armResult({ perQuery: scores({ Q113: 1, Q101: 0 }) }),
        new Set(["Q113", "Q101"]),
      ),
    ]);
    expect(md).toContain("snake MINUS the 5 upper-bound");
    expect(md).toContain("| 0.500 | 2 | 0.000 | 1 | 1.000 | 1 |");
  });
});
