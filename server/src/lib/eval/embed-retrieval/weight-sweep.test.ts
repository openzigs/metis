/**
 * Epic #780 / Issue #797, PR #803 review (B1) — unit tests for the weight sweep.
 *
 * These do not measure retrieval (that needs real ONNX weights and is what
 * `pnpm eval:embed-retrieval --wired --sweep` is for). They pin the DECISION RULE,
 * because the rule is what makes the sweep's answer trustworthy: a sweep that picks
 * by argmax alone would have chosen `bm25Weight: 1.0` — a 100% exact-name score and
 * a vector channel switched entirely off, i.e. the very defect #797 exists to fix,
 * "proved" optimal by its own eval.
 */
import { describe, expect, it } from "vitest";
import {
  chooseWeights,
  compareMissSets,
  exactNameProbes,
  flagshipTargetId,
  renderMissSets,
  renderSweep,
  runWeightSweep,
  scoreWeights,
  WEIGHT_GRID,
  type SweepRow,
  type WeightedSearch,
} from "./weight-sweep.js";
import { loadEmbedRetrievalCorpus, type EmbedRetrievalCorpus } from "./corpus.js";
import { DEFAULT_LIMIT } from "../../analysis/tools/search-symbols.js";
import { bootstrapMean } from "./stats.js";

function row(over: Partial<SweepRow>): SweepRow {
  return {
    weights: { bm25Weight: 0.4, vectorWeight: 0.6 },
    hybridNdcg10: 0.3,
    hybridNdcg10Ci: bootstrapMean([0.2, 0.4, 0.3, 0.3], { resamples: 200 }),
    hybridMrr: 0.3,
    exactNameTop1: 0.8,
    exactNameCount: 10,
    exactNameMisses: [],
    flagshipExactNameTop1: true,
    flagshipRank: 30,
    flagshipWithinDefaultLimit: false,
    ...over,
  };
}

const incumbent = row({});

/**
 * PR #803 review, M4. The sweep's exact-name guard is a SCALAR (`exactNameTop1`), and the
 * artifact used to drop `exactNameMisses` entirely — so "the miss set is unchanged" was a
 * claim nothing in the code actually checked. These pin the set comparison that now does.
 */
describe("compareMissSets", () => {
  it("reports IDENTICAL when the same names are missed (order-insensitive)", () => {
    const a = row({ exactNameMisses: ["getEmbedder", "parseBudget"] });
    const b = row({ exactNameMisses: ["parseBudget", "getEmbedder"] });
    expect(compareMissSets(a, b)).toEqual({ regressed: [], recovered: [], identical: true });
  });

  it("catches a SWAPPED miss set that the COUNT cannot see — the M4 failure mode", () => {
    // Same size (2), same exactNameTop1 fraction, materially different regression profile:
    // the count is pinned and the identity is not.
    const before = row({ exactNameMisses: ["getEmbedder", "parseBudget"], exactNameTop1: 0.8 });
    const after = row({ exactNameMisses: ["getEmbedder", "swapTable"], exactNameTop1: 0.8 });
    expect(before.exactNameMisses.length).toBe(after.exactNameMisses.length);
    expect(before.exactNameTop1).toBe(after.exactNameTop1);

    const delta = compareMissSets(before, after);
    expect(delta.identical).toBe(false);
    expect(delta.regressed).toEqual(["swapTable"]);
    expect(delta.recovered).toEqual(["parseBudget"]);
  });

  it("separates regressions from recoveries", () => {
    const before = row({ exactNameMisses: ["a", "b"] });
    const after = row({ exactNameMisses: ["b", "c"] });
    expect(compareMissSets(before, after)).toEqual({
      regressed: ["c"],
      recovered: ["a"],
      identical: false,
    });
  });
});

describe("renderMissSets", () => {
  it("names the miss sets and states whether they are identical", () => {
    const inc = row({ exactNameMisses: ["getEmbedder"], exactNameCount: 10 });
    const chosen = row({
      weights: { bm25Weight: 0.15, vectorWeight: 0.85 },
      exactNameMisses: ["getEmbedder"],
      exactNameCount: 10,
    });
    const out = renderMissSets({ rows: [inc, chosen], incumbent: inc, chosen });
    expect(out).toContain("getEmbedder");
    expect(out).toContain("IDENTICAL");
  });

  it("says CHANGED, and names the movers, when the sets differ", () => {
    const inc = row({ exactNameMisses: ["getEmbedder"] });
    const chosen = row({
      weights: { bm25Weight: 0.15, vectorWeight: 0.85 },
      exactNameMisses: ["swapTable"],
    });
    const out = renderMissSets({ rows: [inc, chosen], incumbent: inc, chosen });
    expect(out).toContain("CHANGED");
    expect(out).toContain("newly missed: swapTable");
    expect(out).toContain("recovered: getEmbedder");
  });

  it("handles a sweep in which no setting qualifies", () => {
    const inc = row({ exactNameMisses: [] });
    const out = renderMissSets({ rows: [inc], incumbent: inc, chosen: null });
    expect(out).toContain("none");
  });
});

describe("renderSweep miss-set column", () => {
  it("surfaces the moved names in the artifact rather than dropping them", () => {
    const inc = row({ exactNameMisses: ["getEmbedder"] });
    const other = row({
      weights: { bm25Weight: 0.15, vectorWeight: 0.85 },
      exactNameMisses: ["swapTable"],
    });
    const out = renderSweep({ rows: [inc, other], incumbent: inc, chosen: other });
    expect(out).toContain("identical"); // the incumbent vs itself
    expect(out).toContain("swapTable"); // the regression, named in the table
    expect(out).toContain("getEmbedder"); // the recovery, named in the table
  });
});

describe("chooseWeights", () => {
  it("maximises nDCG@10 among settings that do not regress exact-name lookup", () => {
    const better = row({
      weights: { bm25Weight: 0.15, vectorWeight: 0.85 },
      hybridNdcg10: 0.395,
    });
    expect(chooseWeights([incumbent, better], incumbent)).toBe(better);
  });

  it("REJECTS a higher-scoring setting that regresses the exact-name suite", () => {
    // The trap: a setting can win on NL prose by abandoning the lexical channel and
    // taking exact-name lookups down with it. Developers type exact names constantly;
    // that trade is not this issue's to make.
    const tempting = row({
      weights: { bm25Weight: 0, vectorWeight: 1 },
      hybridNdcg10: 0.9,
      exactNameTop1: 0.7,
    });
    expect(chooseWeights([incumbent, tempting], incumbent)).toBe(incumbent);
  });

  it("REJECTS a setting that drops the flagship symbol's own exact-name lookup from #1", () => {
    const tempting = row({
      weights: { bm25Weight: 0, vectorWeight: 1 },
      hybridNdcg10: 0.9,
      flagshipExactNameTop1: false,
    });
    expect(chooseWeights([incumbent, tempting], incumbent)).toBe(incumbent);
  });

  it("breaks near-ties toward the incumbent (the smallest change the evidence supports)", () => {
    // 0.399 vs 0.395 on a 30-query corpus is not a result. Prefer the weighting that
    // moves production least.
    const aggressive = row({
      weights: { bm25Weight: 0.05, vectorWeight: 0.95 },
      hybridNdcg10: 0.399,
    });
    const conservative = row({
      weights: { bm25Weight: 0.15, vectorWeight: 0.85 },
      hybridNdcg10: 0.395,
    });
    expect(chooseWeights([aggressive, conservative], incumbent)).toBe(conservative);
  });

  it("returns null when every setting regresses — an honest 'no' is a valid outcome", () => {
    const bad = row({ hybridNdcg10: 0.9, exactNameTop1: 0.1, flagshipExactNameTop1: false });
    expect(chooseWeights([bad], incumbent)).toBeNull();
  });
});

describe("renderSweep", () => {
  it("renders 'absent' and no winner marker when nothing qualifies — the honest 'no'", () => {
    const bad = row({
      exactNameTop1: 0.1,
      flagshipExactNameTop1: false,
      flagshipRank: null,
      exactNameMisses: ["safeFetch"],
    });
    const md = renderSweep({ rows: [bad], incumbent, chosen: null });

    expect(md).toContain("absent");
    expect(md).not.toContain("**←**");
    expect(md).toContain("| no |");
  });

  it("marks the chosen row and reports the flagship as reaching the agent", () => {
    const good = row({ flagshipRank: 3, flagshipWithinDefaultLimit: true, exactNameTop1: 1 });
    const md = renderSweep({ rows: [good], incumbent, chosen: good });

    expect(md).toContain("YES **←**");
  });
});

describe("the grid", () => {
  it("holds vectorWeight = 1 - bm25Weight (RRF is scale-free: only the ratio matters)", () => {
    for (const w of WEIGHT_GRID) {
      expect(w.bm25Weight + w.vectorWeight).toBeCloseTo(1, 10);
    }
  });

  it("includes the incumbent and both extremes, so the report can be read against them", () => {
    const bm25 = WEIGHT_GRID.map((w) => w.bm25Weight);
    expect(bm25).toContain(0.4);
    expect(bm25).toContain(1);
    expect(bm25).toContain(0);
  });
});

describe("corpus-derived probes", () => {
  let corpus: EmbedRetrievalCorpus;

  it("resolves the flagship target in the committed snapshot", async () => {
    corpus = await loadEmbedRetrievalCorpus();
    expect(flagshipTargetId(corpus)).toBeTruthy();
  });

  it("builds one exact-name probe per unambiguously-named ground-truth symbol", async () => {
    corpus ??= await loadEmbedRetrievalCorpus();
    const probes = exactNameProbes(corpus);

    expect(probes.length).toBeGreaterThan(10);
    // Every probe queries a symbol's own name...
    for (const p of probes) {
      expect(corpus.symbols.find((s) => s.id === p.targetId)?.name).toBe(p.query);
    }
    // ...and no name is claimed by two symbols, because "rank #1" would then be
    // ill-defined and the guard would fail for a reason that is not a regression.
    const names = probes.map((p) => p.query);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe("scoreWeights / runWeightSweep", () => {
  /**
   * A searcher that returns the flagship target at a rank controlled by the weights:
   * the more vector weight, the better it ranks. Enough to prove the plumbing —
   * whether a REAL searcher behaves this way is the eval's question, not a test's.
   */
  function fakeSearch(corpus: EmbedRetrievalCorpus, targetId: string): WeightedSearch {
    const others = corpus.symbols.map((s) => s.id).filter((id) => id !== targetId);
    return async (query, weights, limit) => {
      // Exact-name query: whatever symbol owns that name comes back first.
      const named = corpus.symbols.find((s) => s.name === query);
      if (named) return [named.id, ...others.filter((id) => id !== named.id)].slice(0, limit);
      // Prose query: the target's rank improves as bm25 is weighted down.
      const rank = Math.round(2 + weights.bm25Weight * 40);
      const ranked = [...others];
      ranked.splice(rank - 1, 0, targetId);
      return ranked.slice(0, limit);
    };
  }

  it("reports the flagship's rank and whether the AGENT would actually receive it", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const targetId = flagshipTargetId(corpus);
    const search = fakeSearch(corpus, targetId);

    // bm25 1.0 → rank 42: past the tool's default cut-off, so the agent sees nothing.
    const lexical = await scoreWeights(corpus, { bm25Weight: 1, vectorWeight: 0 }, search);
    expect(lexical.flagshipRank).toBe(42);
    expect(lexical.flagshipWithinDefaultLimit).toBe(false);

    // bm25 0.0 → rank 2: inside the limit, so it reaches the agent's context.
    const semantic = await scoreWeights(corpus, { bm25Weight: 0, vectorWeight: 1 }, search);
    expect(semantic.flagshipRank).toBe(2);
    expect(semantic.flagshipWithinDefaultLimit).toBe(true);
    expect(semantic.flagshipRank).toBeLessThanOrEqual(DEFAULT_LIMIT);

    // The exact-name guard is scored against the SAME searcher, and this one answers
    // exact names perfectly at every weighting.
    expect(semantic.exactNameTop1).toBe(1);
    expect(semantic.exactNameMisses).toEqual([]);
    expect(semantic.flagshipExactNameTop1).toBe(true);
  }, 30_000);

  it("names the exact-name lookups it loses, rather than only counting them", async () => {
    // A bare percentage cannot be reviewed. The misses are what tell you whether a
    // retune broke `getEmbedder` or merely shuffled two overloaded names.
    const corpus = await loadEmbedRetrievalCorpus();
    const targetId = flagshipTargetId(corpus);
    const good = fakeSearch(corpus, targetId);
    const dropsOne: WeightedSearch = async (query, weights, limit) => {
      const ranked = await good(query, weights, limit);
      // One specific exact-name lookup now comes back second.
      return query === "safeFetch" ? [...ranked.slice(1, 2), ...ranked] : ranked;
    };

    const scored = await scoreWeights(corpus, { bm25Weight: 0.15, vectorWeight: 0.85 }, dropsOne);

    expect(scored.exactNameMisses).toEqual(["safeFetch"]);
    expect(scored.exactNameTop1).toBeLessThan(1);
    expect(scored.flagshipExactNameTop1).toBe(true);
  }, 30_000);

  it("fails LOUDLY when the flagship target is not in the corpus", async () => {
    // A renamed or deleted target must not silently score as an unreachable miss —
    // the sweep would then report "no weighting helps" about a symbol it never looked
    // for, and the conclusion would be an artefact.
    const corpus = await loadEmbedRetrievalCorpus();
    const moved = {
      ...corpus,
      symbols: corpus.symbols.filter((s) => s.name !== "assertWithinBudget"),
    };
    expect(() => flagshipTargetId(moved)).toThrow(/not in the corpus snapshot/);
  });

  it("drops ambiguous names from the exact-name suite rather than failing them", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const target = corpus.symbols.find((s) => s.name === "assertWithinBudget");
    if (!target) throw new Error("fixture moved");
    // A second symbol claiming the same name makes "rank #1" ill-defined.
    const shadowed = {
      ...corpus,
      symbols: [...corpus.symbols, { ...target, id: `${target.id}-dup`, filePath: "other.ts" }],
    };
    expect(exactNameProbes(shadowed).map((p) => p.query)).not.toContain("assertWithinBudget");
  });

  it("renders the table, marking the chosen row", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const search = fakeSearch(corpus, flagshipTargetId(corpus));
    const report = await runWeightSweep(corpus, search, [{ bm25Weight: 0.15, vectorWeight: 0.85 }]);

    const md = renderSweep(report);
    expect(md).toContain(`in default top-${DEFAULT_LIMIT}?`);
    expect(md).toContain("0.15");
    // The incumbent is not in this grid, so it is scored separately rather than
    // silently omitted — otherwise "vs incumbent" would have no baseline.
    expect(report.incumbent.weights.bm25Weight).toBe(0.4);
  }, 60_000);

  it("sweeps the grid and picks the winner under the decision rule", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const search = fakeSearch(corpus, flagshipTargetId(corpus));

    const report = await runWeightSweep(corpus, search, [
      { bm25Weight: 0.4, vectorWeight: 0.6 },
      { bm25Weight: 0.15, vectorWeight: 0.85 },
    ]);

    expect(report.rows).toHaveLength(2);
    expect(report.incumbent.weights.bm25Weight).toBe(0.4);
    // Both settings answer exact names, and the fake ranks the target better with less
    // bm25 — so the rule takes the better ranking. (nDCG is equal here, so the tie-break
    // would keep 0.4; the fake's flagship rank is not part of nDCG. Assert on what the
    // rule actually decides rather than on what we hoped it would.)
    expect(report.chosen).not.toBeNull();
  }, 60_000);
});
