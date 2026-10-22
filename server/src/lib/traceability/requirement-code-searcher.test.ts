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
  type KeywordRuleCause,
  type LinkGate,
  type RequirementRetrievalMode,
} from "./requirement-code-mapping.js";
import {
  HYBRID_CANDIDATE_POOL,
  HybridCodeSymbolSearcher,
  activeSemanticModel,
  capBelowMeasured,
  createRequirementCodeSearcher,
  prismaEmbeddingModels,
  type EmbeddingModelLookup,
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
  hits: Array<{ id: string; cosine?: number; kind?: string }>,
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
        kind: h.kind ?? "function",
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
  opts: {
    model?: string | null;
    rows?: Row[];
    /** #1417 — `CodeSymbolEmbedding.embeddingModel` per symbol id; absent = no lookup. */
    embeddingModels?: EmbeddingModelLookup;
  } = {},
): HybridCodeSymbolSearcher {
  return new HybridCodeSymbolSearcher({
    bm25: new MemoizingBm25CodeSymbolSearcher(prismaOf(opts.rows).prisma),
    hybrid: ranker,
    semanticModel: () => (opts.model === undefined ? GTE : opts.model),
    ...(opts.embeddingModels ? { embeddingModels: opts.embeddingModels } : {}),
  });
}

/** #1417 — an embedding-row lookup answering from fixed tags (`""` = pending). */
function tagsOf(tags: Record<string, string>) {
  const lookup = vi.fn(async (_projectId: string, ids: readonly string[]) => {
    const out = new Map<string, string>();
    for (const id of ids) if (id in tags) out.set(id, tags[id]!);
    return out;
  });
  return lookup;
}

/** The run-7 sample's code symbols, every one embedded under the calibrated model. */
const ALL_EMBEDDED = Object.fromEntries(ROWS.map((r) => [r.id, GTE]));

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

describe("HybridCodeSymbolSearcher — calibration holes (review of PRs #1325 and #1410)", () => {
  const links = (
    ranker: HybridRanker,
    model?: string,
    rows?: Row[],
    embeddingModels?: EmbeddingModelLookup,
  ) =>
    searcherOf(ranker, {
      ...(model === undefined ? {} : { model }),
      ...(rows ? { rows } : {}),
      ...(embeddingModels ? { embeddingModels } : {}),
    }).withOptions(ANALYSIS_LINK_SEARCH_OPTIONS, ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS);
  type Gate = [LinkGate, KeywordRuleCause | undefined];
  const gatesOf = () => {
    const gates: Gate[] = [];
    return {
      gates,
      onLinkGate: (g: LinkGate, c?: KeywordRuleCause) => gates.push([g, c]),
    };
  };

  // #1330 — a hit the vector channel did not return has no usable cosine, so
  // one shared word must not clear the floor through it; the measured hits
  // beside it keep the floor.
  it("gates a hit with no vector by the two-term rule, hit by hit; measured hits keep the floor", async () => {
    // `button` shares one word; the embedded hits are close (0.6 or more).
    const { ranker } = rankerOf([
      { id: "flush", cosine: 0.7 },
      { id: "remove", cosine: 0.62 },
      { id: "button" },
    ]);
    const raw = await searcherOf(ranker).search(TERMINATE, PROJECT);
    const conf = new Map(raw.map((c) => [c.symbolId, c.confidence]));
    expect(conf.get("flush")).toBe(linkConfidence({ sharedNameTerms: 1, cosine: 0.7 }));
    // Its cosine is unknown: scored on words alone (0.096, which WOULD clear 0.08).
    expect(conf.get("button")).toBe(linkConfidence({ sharedNameTerms: 1 }));
    expect(conf.get("button")!).toBeGreaterThanOrEqual(
      ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS.minConfidence!,
    );
    const modes: RequirementRetrievalMode[] = [];
    const { gates, onLinkGate } = gatesOf();
    const shown = await links(ranker).search(TERMINATE, PROJECT, {
      onRetrievalMode: (m) => modes.push(m),
      onLinkGate,
    });
    expect(shown.map((c) => c.symbolId)).toEqual(["flush", "remove"]);
    expect(modes).toEqual(["hybrid"]);
    // No shown link was decided by the keyword rule.
    expect(gates).toEqual([["hybrid", undefined]]);
  });

  it("keeps a small, fully embedded project with a database schema on the floor (tables are never embedded)", async () => {
    const rows: Row[] = [
      ...ROWS,
      {
        id: "table",
        name: "web_sessions",
        qualifiedName: "web_sessions",
        kind: "table",
        filePath: "schema.sql",
      },
    ];
    // Every code symbol is embedded; the table has no vector and never will.
    const { ranker } = rankerOf([{ id: "flush", cosine: 0.7 }, { id: "table" }]);
    const { gates, onLinkGate } = gatesOf();
    const shown = await links(ranker, undefined, rows).search(
      "Terminate all web sessions",
      PROJECT,
      { onLinkGate },
    );
    // The one-word semantic link stays (the floor decided it) ...
    expect(shown.map((c) => c.symbolId)).toContain("flush");
    expect(shown.find((c) => c.symbolId === "flush")!.confidence).toBe(
      linkConfidence({ sharedNameTerms: 1, cosine: 0.7 }),
    );
    // ... and the table, which shares two words, is shown by the keyword rule.
    expect(shown.map((c) => c.symbolId)).toContain("table");
    expect(gates).toEqual([["hybrid", undefined]]);
    // #1417 — each candidate says which rule let it through, and why.
    const table = shown.find((c) => c.symbolId === "table")!;
    expect(table).toMatchObject({ linkGate: "keyword", keywordRuleCause: "schema-not-embedded" });
    expect(shown.find((c) => c.symbolId === "flush")).toMatchObject({ linkGate: "hybrid" });
    expect(shown.find((c) => c.symbolId === "flush")).not.toHaveProperty("keywordRuleCause");
  });

  it("names a code hit whose cause cannot be read `no-vector` (no embedding-row lookup)", async () => {
    // `restoreButtonState` was not returned by the vector channel and shares two
    // words ("restore", "button"; "state" is a #943 stopword). With no lookup,
    // nothing says whether it has a vector: the keyword rule shows it, as under #1330.
    const { ranker } = rankerOf([{ id: "flush", cosine: 0.7 }, { id: "restore" }]);
    const shown = await links(ranker).search(
      "Flush all sessions and restore the button state",
      PROJECT,
    );
    expect(shown.map((c) => c.symbolId)).toEqual(["flush", "restore"]);
    expect(shown[1]).toMatchObject({
      confidence: linkConfidence({ sharedNameTerms: 2 }),
      linkGate: "keyword",
      keywordRuleCause: "no-vector",
    });
  });

  // #1417 (review of PR #1410) — the 0.273 construction: measured hits at 0.7 and
  // 0.35; `restoreButtonState` shares two words and HAS a vector under the active
  // model, which the search lost. It must not outrank the measured links.
  it("bounds a hit whose vector the search lost by the lowest returned cosine: it does not outrank measured links", async () => {
    const query = "Flush all sessions and restore the button state";
    const { ranker } = rankerOf([
      { id: "flush", cosine: 0.7 },
      { id: "remove", cosine: 0.35 },
      { id: "restore" },
    ]);
    const lookup = tagsOf(ALL_EMBEDDED);
    const shown = await links(ranker, undefined, undefined, lookup).search(query, PROJECT);
    // Scored at the lowest returned cosine (0.35): 0.022, under the 0.08 floor.
    expect(linkConfidence({ sharedNameTerms: 2, cosine: 0.35 })).toBeLessThan(
      ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS.minConfidence!,
    );
    expect(shown.map((c) => c.symbolId)).toEqual(["flush"]);
    // One batched lookup, for the hits the vector channel did not return only.
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(PROJECT, ["restore"]);
    // Without the floor it is capped strictly below the lowest measured link.
    const raw = await searcherOf(ranker, { embeddingModels: lookup }).search(query, PROJECT);
    const restore = raw.find((c) => c.symbolId === "restore")!;
    expect(restore).toMatchObject({ linkGate: "hybrid" });
    expect(restore).not.toHaveProperty("keywordRuleCause");
    const measured = raw.filter((c) => c.symbolId !== "restore").map((c) => c.confidence!);
    expect(restore.confidence!).toBeLessThan(Math.min(...measured));
    expect(raw.at(-1)!.symbolId).toBe("restore");
  });

  // #1417 (review of PR #1419) — few, close survivors: the lowest returned cosine
  // is 0.61, so the lost two-word hit scores 0.239 at it, over both one-word
  // measured links (0.105, 0.096). The cap keeps it under them.
  it("never ranks a lost-vector hit above a measured link, even when few, close vector hits survive", async () => {
    const query = "Flush all sessions and restore the button state";
    const { ranker } = rankerOf([
      { id: "button", cosine: 0.62 },
      { id: "remove", cosine: 0.61 },
      { id: "restore" },
    ]);
    // Precondition: uncapped, it would outrank both.
    const uncapped = linkConfidence({ sharedNameTerms: 2, cosine: 0.61 });
    expect(uncapped).toBe(0.239);
    const lookup = tagsOf(ALL_EMBEDDED);
    for (const searcher of [
      links(ranker, undefined, undefined, lookup),
      searcherOf(ranker, { embeddingModels: lookup }),
    ]) {
      const out = await searcher.search(query, PROJECT);
      expect(out.map((c) => c.symbolId)).toEqual(["button", "remove", "restore"]);
      const conf = new Map(out.map((c) => [c.symbolId, c.confidence!]));
      expect(conf.get("button")).toBe(linkConfidence({ sharedNameTerms: 1, cosine: 0.62 }));
      expect(conf.get("remove")).toBe(linkConfidence({ sharedNameTerms: 1, cosine: 0.61 }));
      expect(conf.get("restore")).toBe(Math.round((conf.get("remove")! - 0.001) * 1000) / 1000);
      expect(conf.get("restore")!).toBeLessThan(conf.get("remove")!);
    }
  });

  // #1417 (cycle-2 review) — the floor is re-applied AFTER the cap, before the
  // mapper (whose own floor is 0.03) can see the capped hit.
  it("drops a lost-vector hit the cap puts under the 0.08 floor, end to end through the mapper", async () => {
    const title = "Flush all sessions and restore the button state";
    // `button` shares one word at cosine 0.591: exactly 0.080, the lowest kept.
    const { ranker } = rankerOf([{ id: "button", cosine: 0.591 }, { id: "restore" }]);
    expect(linkConfidence({ sharedNameTerms: 1, cosine: 0.591 })).toBe(0.08);
    // Uncapped, the lost two-word hit clears the floor (0.206); capped, it reads 0.079.
    expect(linkConfidence({ sharedNameTerms: 2, cosine: 0.591 })).toBeGreaterThan(0.08);
    expect(DEFAULT_MIN_CONFIDENCE).toBeLessThan(0.079);
    const matches = await mapRequirementToCode(
      { id: "NR-1", title, body: "" },
      PROJECT,
      {},
      { searcher: links(ranker, undefined, undefined, tagsOf(ALL_EMBEDDED)) },
    );
    expect(matches.map((m) => m.codeSymbolId)).toEqual(["button"]);
    expect(matches[0]!.confidence).toBe(0.08);
  });

  it("capBelowMeasured: keeps nothing with no measured link, and drops a hit the cap puts under the floor", () => {
    const cand = (symbolId: string, confidence: number) => ({
      symbolId,
      filePath: "",
      qualifiedName: symbolId,
      name: symbolId,
      kind: "function",
      score: 1,
      confidence,
    });
    expect(capBelowMeasured([cand("lost", 0.3)], [], 0.08)).toEqual([]);
    expect(capBelowMeasured([cand("lost", 0.3)], [cand("m", 0.08)], 0.08)).toEqual([]);
    expect(capBelowMeasured([cand("lost", 0.3)], [cand("m", 0.2)], undefined)).toEqual([
      { ...cand("lost", 0.199), linkGate: "hybrid" },
    ]);
    // A bounded hit already under the cap keeps its own confidence.
    expect(capBelowMeasured([cand("lost", 0.05)], [cand("m", 0.2)], 0.03)[0]!.confidence).toBe(
      0.05,
    );
  });

  it("tells code still being embedded, another model's, and none apart, each by the keyword rule", async () => {
    const query = "Flush all sessions and restore the button state";
    const cases: Array<[string | undefined, KeywordRuleCause]> = [
      ["", "embedding-pending"],
      ["BAAI/bge-small-en-v1.5", "other-model"],
      [undefined, "not-embedded"],
    ];
    for (const [tag, cause] of cases) {
      const { ranker } = rankerOf([{ id: "flush", cosine: 0.7 }, { id: "restore" }]);
      const tags: Record<string, string> = { flush: GTE };
      if (tag !== undefined) tags.restore = tag;
      const shown = await links(ranker, undefined, undefined, tagsOf(tags)).search(query, PROJECT);
      expect(
        shown.find((c) => c.symbolId === "restore"),
        cause,
      ).toMatchObject({
        confidence: linkConfidence({ sharedNameTerms: 2 }),
        linkGate: "keyword",
        keywordRuleCause: cause,
      });
    }
  });

  it("reports both causes of a mixed answer (a table and code still being embedded)", async () => {
    const rows: Row[] = [
      ...ROWS,
      {
        id: "table",
        name: "web_sessions",
        qualifiedName: "web_sessions",
        kind: "table",
        filePath: "schema.sql",
      },
    ];
    const { ranker } = rankerOf([{ id: "flush", cosine: 0.7 }, { id: "table" }, { id: "restore" }]);
    const shown = await links(ranker, undefined, rows, tagsOf({ flush: GTE, restore: "" })).search(
      "Flush web sessions and restore the button state",
      PROJECT,
    );
    const causes = new Map(shown.map((c) => [c.symbolId, c.keywordRuleCause]));
    expect(causes).toEqual(
      new Map([
        ["flush", undefined],
        ["table", "schema-not-embedded"],
        ["restore", "embedding-pending"],
      ]),
    );
  });

  it("caps every hit without a cosine like a lost vector when the embedding rows cannot be read", async () => {
    const { ranker } = rankerOf([
      { id: "button", cosine: 0.62 },
      { id: "remove", cosine: 0.61 },
      { id: "restore" },
    ]);
    const failing: EmbeddingModelLookup = async () => {
      throw new Error("db down");
    };
    const shown = await links(ranker, undefined, undefined, failing).search(
      "Flush all sessions and restore the button state",
      PROJECT,
    );
    // Not 0.273 on words alone: bounded, capped under the measured links, last.
    expect(shown.map((c) => c.symbolId)).toEqual(["button", "remove", "restore"]);
    expect(shown[2]).toMatchObject({ linkGate: "hybrid" });
    expect(shown[2]).not.toHaveProperty("keywordRuleCause");
    expect(shown[2]!.confidence!).toBeLessThan(shown[1]!.confidence!);
  });

  it("keeps a table with the keyword rule (`schema-not-embedded`) when the embedding rows cannot be read", async () => {
    const rows: Row[] = [
      ...ROWS,
      {
        id: "table",
        name: "web_sessions",
        qualifiedName: "web_sessions",
        kind: "table",
        filePath: "schema.sql",
      },
    ];
    const { ranker } = rankerOf([
      { id: "flush", cosine: 0.7 },
      { id: "table", kind: "table" },
    ]);
    const failing: EmbeddingModelLookup = async () => {
      throw new Error("db down");
    };
    const shown = await links(ranker, undefined, rows, failing).search(
      "Terminate all web sessions",
      PROJECT,
    );
    // A table is never embedded: not a possible lost vector, so not capped.
    expect(shown.find((c) => c.symbolId === "table")).toMatchObject({
      linkGate: "keyword",
      keywordRuleCause: "schema-not-embedded",
      confidence: linkConfidence({ sharedNameTerms: 2 }),
    });
  });

  it("leaves an active-model hit to the keyword rule when no returned cosine can bound it", async () => {
    // The answer reads hybrid but no hit carries a cosine: nothing bounds the lost vector.
    const { ranker } = rankerOf([{ id: "restore" }]);
    const shown = await links(ranker, undefined, undefined, tagsOf(ALL_EMBEDDED)).search(
      "Restore the button state",
      PROJECT,
    );
    expect(shown).toEqual([
      expect.objectContaining({
        symbolId: "restore",
        linkGate: "keyword",
        keywordRuleCause: "no-vector",
      }),
    ]);
  });

  // #1417 — `limit` cuts in the order the mapper reads (confidence), so a
  // keyword-ruled hit stronger than measured ones is not cut behind them.
  it("cuts to the limit by confidence, not by the fused order", async () => {
    const { ranker } = rankerOf([
      { id: "button", cosine: 0.62 },
      { id: "remove", cosine: 0.61 },
      { id: "restore" },
    ]);
    const out = await searcherOf(ranker).search(
      "Flush all sessions and restore the button state",
      PROJECT,
      { limit: 1 },
    );
    // `restore` (two words, 0.273) beats both measured hits; the fused order put it last.
    expect(out.map((c) => c.symbolId)).toEqual(["restore"]);
  });

  it("gates a hybrid answer with no cosine at all by the two-term rule", async () => {
    const { ranker } = rankerOf([{ id: "flush" }, { id: "button" }]);
    const shown = await links(ranker).search(TERMINATE, PROJECT);
    expect(shown).toEqual([]);
  });

  it("gates an uncalibrated model's links with the keyword rules (two shared name terms)", async () => {
    const { ranker } = rankerOf([{ id: "flush", cosine: 0.9 }]);
    // `FlushAllSessions` shares ONE word: the hybrid floor would show it (0.096 ≥ 0.08) ...
    expect(await links(ranker, GTE).search(TERMINATE, PROJECT)).not.toEqual([]);
    // ... but with no calibrated cosine nothing semantic gates it, so the #1095 rule does.
    const modes: RequirementRetrievalMode[] = [];
    const { gates, onLinkGate } = gatesOf();
    const out = await links(ranker, "BAAI/bge-small-en-v1.5").search(TERMINATE, PROJECT, {
      onRetrievalMode: (m) => modes.push(m),
      onLinkGate,
    });
    expect(out).toEqual([]);
    expect(modes).toEqual(["hybrid"]);
    expect(gates).toEqual([["keyword", "uncalibrated-model"]]);
  });
});
describe("HybridCodeSymbolSearcher — falls back to BM25 and says so", () => {
  async function fallsBack(
    searcher: HybridCodeSymbolSearcher,
  ): Promise<RequirementRetrievalMode[]> {
    const modes: RequirementRetrievalMode[] = [];
    const gates: LinkGate[] = [];
    const out = await searcher.search(TERMINATE, PROJECT, {
      onRetrievalMode: (m) => modes.push(m),
      onLinkGate: (g) => gates.push(g),
    });
    expect(out.length).toBeGreaterThan(0);
    // The fallback's links are decided by its own (keyword) rules (#1330).
    expect(gates).toEqual(["keyword"]);
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

  it("reads the hits' embedding rows in one query, scoped to the project", async () => {
    const findMany = vi.fn(async () => [
      { symbolId: "a", embeddingModel: GTE },
      { symbolId: "b", embeddingModel: "" },
    ]);
    const lookup = prismaEmbeddingModels({ codeSymbolEmbedding: { findMany } } as never);
    const tags = await lookup(PROJECT, ["a", "b", "c"]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { projectId: PROJECT, symbolId: { in: ["a", "b", "c"] } },
      select: { symbolId: true, embeddingModel: true },
    });
    expect([...tags]).toEqual([
      ["a", GTE],
      ["b", ""],
    ]);
  });
});
