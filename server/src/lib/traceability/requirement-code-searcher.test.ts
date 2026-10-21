/**
 * #1097 — the requirement→code mapper ranks with the hybrid search by default
 * and falls back to BM25, saying which ran; confidence is absolute.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { HybridSearchOptions, HybridSearchResult } from "../code-graph/hybrid-search.js";
import {
  ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
  ANALYSIS_LINK_SEARCH_OPTIONS,
  DEFAULT_MIN_CONFIDENCE,
  MemoizingBm25CodeSymbolSearcher,
  linkConfidence,
  mapRequirementToCode,
  type RequirementRetrievalMode,
} from "./requirement-code-mapping.js";
import {
  HYBRID_CANDIDATE_POOL,
  HybridCodeSymbolSearcher,
  activeSemanticModel,
  createRequirementCodeSearcher,
  type HybridRanker,
} from "./requirement-code-searcher.js";

const PROJECT = "p1";
const GTE = "Alibaba-NLP/gte-modernbert-base";

interface Row {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
}

/** A Miniflux-shaped excerpt: the run-7 "terminate all sessions" case. */
const ROWS: Row[] = [
  {
    id: "flush",
    name: "FlushAllSessions",
    qualifiedName: "internal/storage/web_session.go::FlushAllSessions",
    kind: "function",
    filePath: "internal/storage/web_session.go",
  },
  {
    id: "remove",
    name: "removeSession",
    qualifiedName: "internal/ui/session_remove.go::removeSession",
    kind: "function",
    filePath: "internal/ui/session_remove.go",
  },
  {
    id: "button",
    name: "InlineKeyboardButton",
    qualifiedName: "internal/integration/telegrambot/client.go::InlineKeyboardButton",
    kind: "class",
    filePath: "internal/integration/telegrambot/client.go",
  },
  {
    id: "restore",
    name: "restoreButtonState",
    qualifiedName: "internal/ui/static/js/app.js::restoreButtonState",
    kind: "function",
    filePath: "internal/ui/static/js/app.js",
  },
  {
    id: "test",
    name: "TestFlushAllSessions",
    qualifiedName: "internal/storage/web_session_test.go::TestFlushAllSessions",
    kind: "function",
    filePath: "internal/storage/web_session_test.go",
  },
  {
    id: "doc",
    name: "sessions",
    qualifiedName: "docs/sessions.md::sessions",
    kind: "module",
    filePath: "docs/site/sessions.md",
  },
];

function prismaOf(rows: Row[] = ROWS) {
  const findMany = vi.fn(async (args: { where?: { projectId?: string } }) =>
    args.where?.projectId === PROJECT ? rows.map((r) => ({ ...r, startLine: 1, endLine: 2 })) : [],
  );
  return {
    prisma: { codeSymbol: { findMany } } as unknown as Pick<PrismaClient, "codeSymbol">,
    findMany,
  };
}

/** A hybrid ranker answering with fixed hits (fused score + cosine). */
function rankerOf(
  hits: Array<{ id: string; cosine?: number }>,
  mode: "hybrid" | "bm25-only" = "hybrid",
) {
  const search = vi.fn(
    async (
      _query: string,
      _projectId: string,
      opts?: HybridSearchOptions,
    ): Promise<HybridSearchResult[]> => {
      opts?.onRetrievalMode?.(mode);
      return hits.map((h, i) => ({
        symbolId: h.id,
        filePath: "",
        name: h.id,
        kind: "function",
        score: 1 / (61 + i),
        ...(h.cosine === undefined ? {} : { vectorScore: h.cosine }),
      }));
    },
  );
  return { ranker: { search } as HybridRanker, search };
}

const TERMINATE = "Add a button to terminate all sessions";

function searcherOf(
  ranker: HybridRanker,
  opts: { model?: string | null; rows?: Row[] } = {},
): HybridCodeSymbolSearcher {
  return new HybridCodeSymbolSearcher({
    bm25: new MemoizingBm25CodeSymbolSearcher(prismaOf(opts.rows).prisma),
    hybrid: ranker,
    semanticModel: () => (opts.model === undefined ? GTE : opts.model),
  });
}

describe("HybridCodeSymbolSearcher — ranks with the hybrid search", () => {
  it("returns the hybrid hits in order, with an absolute confidence from words and cosine", async () => {
    const { ranker, search } = rankerOf([
      { id: "flush", cosine: 0.667 },
      { id: "remove", cosine: 0.649 },
    ]);
    const modes: RequirementRetrievalMode[] = [];
    const out = await searcherOf(ranker).search(TERMINATE, PROJECT, {
      limit: 5,
      onRetrievalMode: (m) => modes.push(m),
    });
    expect(modes).toEqual(["hybrid"]);
    expect(out.map((c) => c.symbolId)).toEqual(["flush", "remove"]);
    // `FlushAllSessions` shares "sessions"; `removeSession` shares it as a singular.
    expect(out[0]!.confidence).toBe(linkConfidence({ sharedNameTerms: 1, cosine: 0.667 }));
    expect(out[1]!.confidence).toBe(linkConfidence({ sharedNameTerms: 1, cosine: 0.649 }));
    expect(search).toHaveBeenCalledWith(
      TERMINATE,
      PROJECT,
      expect.objectContaining({ limit: HYBRID_CANDIDATE_POOL }),
    );
  });

  it("drops a hit outside the corpus (a documentation path, #1003)", async () => {
    const { ranker } = rankerOf([
      { id: "doc", cosine: 0.9 },
      { id: "flush", cosine: 0.6 },
    ]);
    const out = await searcherOf(ranker).search(TERMINATE, PROJECT);
    expect(out.map((c) => c.symbolId)).toEqual(["flush"]);
  });

  it("scores the confidence on words alone for a model it was not calibrated on", async () => {
    const { ranker } = rankerOf([{ id: "flush", cosine: 0.9 }]);
    const [hit] = await searcherOf(ranker, { model: "BAAI/bge-small-en-v1.5" }).search(
      TERMINATE,
      PROJECT,
    );
    expect(hit!.confidence).toBe(linkConfidence({ sharedNameTerms: 1 }));
  });

  it("embeds a query once for the links and the seeds (withOptions shares the answers)", async () => {
    const { ranker, search } = rankerOf([{ id: "flush", cosine: 0.7 }]);
    const seeds = searcherOf(ranker);
    const links = seeds.withOptions(
      ANALYSIS_LINK_SEARCH_OPTIONS,
      ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
    );
    await seeds.search(TERMINATE, PROJECT);
    await links.search(TERMINATE, PROJECT);
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("applies the hybrid options to hybrid hits: the two-term rule is not one of them", async () => {
    const { ranker } = rankerOf([
      { id: "flush", cosine: 0.667 },
      { id: "test", cosine: 0.7 },
      { id: "button", cosine: 0.4 },
    ]);
    const links = searcherOf(ranker).withOptions(
      ANALYSIS_LINK_SEARCH_OPTIONS,
      ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
    );
    const out = await links.search(TERMINATE, PROJECT);
    // FlushAllSessions shares ONE word and is kept: the floor, not the rule, decides.
    // The test is not code to show; the far, one-word button is under the floor.
    expect(out.map((c) => c.symbolId)).toEqual(["flush"]);
  });
});

describe("HybridCodeSymbolSearcher — calibration holes (review of PR #1325)", () => {
  const links = (ranker: HybridRanker, model?: string) =>
    searcherOf(ranker, model === undefined ? {} : { model }).withOptions(
      ANALYSIS_LINK_SEARCH_OPTIONS,
      ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
    );

  it("scores a hit only BM25 returned at the vector channel's lowest returned cosine, not as average", async () => {
    // `button` shares one word and the vector channel did not return it.
    const { ranker } = rankerOf([
      { id: "flush", cosine: 0.7 },
      { id: "remove", cosine: 0.55 },
      { id: "button" },
    ]);
    const raw = await searcherOf(ranker).search(TERMINATE, PROJECT);
    const button = raw.find((c) => c.symbolId === "button")!;
    expect(button.confidence).toBe(linkConfidence({ sharedNameTerms: 1, cosine: 0.55 }));
    // Scored as "no cosine" it would clear the floor on one shared word (0.096).
    expect(linkConfidence({ sharedNameTerms: 1 })).toBeGreaterThanOrEqual(
      ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS.minConfidence!,
    );
    const shown = await links(ranker).search(TERMINATE, PROJECT);
    expect(shown.map((c) => c.symbolId)).not.toContain("button");
    expect(shown.map((c) => c.symbolId)).toContain("flush");
  });

  it("gates an uncalibrated model's links with the keyword rules (two shared name terms)", async () => {
    const { ranker } = rankerOf([{ id: "flush", cosine: 0.9 }]);
    // `FlushAllSessions` shares ONE word: the hybrid floor would show it (0.096 ≥ 0.08) ...
    expect(await links(ranker, GTE).search(TERMINATE, PROJECT)).not.toEqual([]);
    // ... but with no calibrated cosine nothing semantic gates it, so the #1095 rule does.
    const modes: RequirementRetrievalMode[] = [];
    const out = await links(ranker, "BAAI/bge-small-en-v1.5").search(TERMINATE, PROJECT, {
      onRetrievalMode: (m) => modes.push(m),
    });
    expect(out).toEqual([]);
    expect(modes).toEqual(["hybrid"]);
  });
});

describe("HybridCodeSymbolSearcher — falls back to BM25 and says so", () => {
  async function fallsBack(
    searcher: HybridCodeSymbolSearcher,
  ): Promise<RequirementRetrievalMode[]> {
    const modes: RequirementRetrievalMode[] = [];
    const out = await searcher.search(TERMINATE, PROJECT, {
      onRetrievalMode: (m) => modes.push(m),
    });
    expect(out.length).toBeGreaterThan(0);
    // Every BM25 candidate carries an absolute confidence too.
    for (const c of out) expect(typeof c.confidence).toBe("number");
    return modes;
  }

  it("when no semantic embedder is configured (the hash stub), without asking the hybrid search", async () => {
    const { ranker, search } = rankerOf([{ id: "flush", cosine: 0.7 }]);
    expect(await fallsBack(searcherOf(ranker, { model: null }))).toEqual(["bm25-only"]);
    expect(search).not.toHaveBeenCalled();
  });

  it("when the vector channel returned nothing (symbols not embedded yet)", async () => {
    const { ranker } = rankerOf([{ id: "button" }], "bm25-only");
    expect(await fallsBack(searcherOf(ranker))).toEqual(["bm25-only"]);
  });

  it("when the hybrid search throws", async () => {
    const ranker: HybridRanker = {
      search: vi.fn(async () => {
        throw new Error("lance is down");
      }),
    };
    expect(await fallsBack(searcherOf(ranker))).toEqual(["bm25-only"]);
  });

  it("answers whether the project has a code graph, loading the corpus once", async () => {
    const { prisma, findMany } = prismaOf();
    const searcher = new HybridCodeSymbolSearcher({
      bm25: new MemoizingBm25CodeSymbolSearcher(prisma),
      hybrid: rankerOf([]).ranker,
      semanticModel: () => null,
    });
    expect(await searcher.hasCodeGraph(PROJECT)).toBe(false); // never searched yet
    expect(await searcher.loadsCodeGraph(PROJECT)).toBe(true);
    expect(await searcher.hasCodeGraph(PROJECT)).toBe(true);
    expect(await searcher.loadsCodeGraph("elsewhere")).toBe(false);
    await searcher.search(TERMINATE, PROJECT);
    expect(findMany).toHaveBeenCalledTimes(2); // PROJECT once, "elsewhere" once
  });
});

describe("mapRequirementToCode — absolute confidence (#1097)", () => {
  it("reports the searcher's confidence as is: the best link is not 1.0 by construction", async () => {
    const { ranker } = rankerOf([
      { id: "flush", cosine: 0.667 },
      { id: "remove", cosine: 0.649 },
    ]);
    const modes: RequirementRetrievalMode[] = [];
    const matches = await mapRequirementToCode(
      { id: "NR-4", title: TERMINATE, body: "" },
      PROJECT,
      { onRetrievalMode: (m) => modes.push(m) },
      { searcher: searcherOf(ranker) },
    );
    expect(modes).toEqual(["hybrid"]);
    expect(matches[0]!.confidence).toBeLessThan(0.5);
    expect(matches.map((m) => m.confidence)).toEqual(
      [...matches.map((m) => m.confidence)].sort((a, b) => b - a),
    );
  });

  it("the same evidence reads the same confidence on two different requirements", async () => {
    const { ranker } = rankerOf([{ id: "flush", cosine: 0.66 }]);
    const searcher = searcherOf(ranker);
    const a = await mapRequirementToCode(
      { id: "a", title: "Terminate all sessions", body: "" },
      PROJECT,
      {},
      { searcher },
    );
    const b = await mapRequirementToCode(
      { id: "b", title: "Show the sessions of a user, newest first, with the device", body: "" },
      PROJECT,
      {},
      { searcher },
    );
    expect(a[0]!.confidence).toBe(b[0]!.confidence);
  });

  it("drops a link under the absolute floor", async () => {
    const { ranker } = rankerOf([{ id: "button", cosine: 0.3 }]);
    const matches = await mapRequirementToCode(
      { id: "x", title: "Unrelated words entirely", body: "" },
      PROJECT,
      {},
      { searcher: searcherOf(ranker) },
    );
    expect(matches).toEqual([]);
    expect(linkConfidence({ sharedNameTerms: 0, cosine: 0.3 })).toBeLessThan(
      DEFAULT_MIN_CONFIDENCE,
    );
  });

  it("defaults to the production searcher, which maps with BM25 offline (tests run AI_OFFLINE)", async () => {
    const modes: RequirementRetrievalMode[] = [];
    const matches = await mapRequirementToCode(
      { id: "NR-4", title: TERMINATE, body: "" },
      PROJECT,
      { onRetrievalMode: (m) => modes.push(m) },
      { prisma: prismaOf().prisma as never },
    );
    expect(modes).toEqual(["bm25-only"]);
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("production wiring", () => {
  it("has no semantic model under AI_OFFLINE (the hash stub serves)", () => {
    expect(activeSemanticModel()).toBeNull();
  });

  it("builds a searcher over any client; it falls back to BM25 offline", async () => {
    const searcher = createRequirementCodeSearcher(prismaOf().prisma);
    const modes: RequirementRetrievalMode[] = [];
    const out = await searcher.search(TERMINATE, PROJECT, {
      onRetrievalMode: (m) => modes.push(m),
    });
    expect(modes).toEqual(["bm25-only"]);
    expect(out.map((c) => c.symbolId)).toContain("flush");
  });
});
