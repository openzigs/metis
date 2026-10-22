/**
 * Issue #1097 — the requirement→code mapper ranks with {@link HybridCodeSearch}
 * (BM25 fused with symbol embeddings) by default, and falls back to the
 * keyword-only BM25 searcher when it cannot.
 *
 * Before #1097 `mapRequirementToCode` ranked by the names-only BM25 searcher
 * alone, so a requirement reached code only through the words both happen to
 * use: "terminate all sessions" could not reach `FlushAllSessions` through
 * "terminate", and "the user's API tokens" could not reach Miniflux's API keys.
 * The vector channel bridges such words; on the #706 run-7 Miniflux sample it
 * ranks `FlushAllSessions`, `removeSession` and `MarkAllAsReadBeforeDate` in
 * the top five of requirements BM25 never linked them to.
 *
 * WHEN IT FALLS BACK, and says so (`onRetrievalMode` reports `bm25-only`):
 *   - no semantic embedder is configured: the active backend is the offline
 *     hash stub (`AI_OFFLINE=1`, `EMBED_BACKEND=offline`, a hash fallback),
 *     whose vectors are not semantic;
 *   - the vector channel returned nothing: the project's symbols are not
 *     embedded under the active model yet, or the embed or vector search
 *     failed (HybridCodeSearch then reports `bm25-only` itself);
 *   - the hybrid search threw.
 * The fallback is the mapper's own BM25 searcher, not HybridCodeSearch's
 * lexical channel: it carries the #943 denoiser and the #1063 link rules,
 * which the analysis path relies on.
 *
 * WHEN THE KEYWORD RULES DECIDE A HYBRID ANSWER (#1330; `onLinkGate` says
 * which and why). The hybrid floor is only honest on a confidence with
 * semantic evidence: one shared name word alone scores 0.096, over the 0.08
 * floor. So the keyword fallback's options decide
 *   - the WHOLE answer when the active model is not one the confidence is
 *     calibrated for (`uncalibrated-model`);
 *   - each HIT the vector channel did not return and that has NO vector
 *     under the active model, hit by hit (#1417 tells this from a lost
 *     vector with one batched read of the hits' `CodeSymbolEmbedding` rows):
 *     a database table or column (never embedded, `schema-not-embedded`),
 *     code still being embedded (`embedding-pending`), code embedded only with
 *     another model (`other-model`), or code with no embedding row
 *     (`not-embedded`). Its cosine is unknown, so it is scored on words alone
 *     and shown only under the two-term rule; the measured hits beside it
 *     keep the floor. Each such candidate carries its gate and cause, so a
 *     caller can tell which SHOWN links the keyword rule decided.
 *
 * A hit the channel did not return although it HAS a vector under the active
 * model (a stale symbol's rows crowded it out, or another model's rows were
 * filtered after the search) is not the keyword rule's: it ranked past every
 * returned vector hit. It is scored at the lowest returned cosine (#1325's
 * bound, an upper bound on its own), and then CAPPED strictly below the
 * lowest confidence of the measured hits kept, so it never ranks above a
 * measured link however few and close the surviving vector hits are; it is
 * shown only if the capped confidence still clears the floor, and not at all
 * when no measured hit is kept. When the embedding rows cannot be read, every
 * hit without a cosine is treated so (the conservative reading).
 *
 * WHAT IS SHARED WITH BM25. The hits HybridCodeSearch ranks are turned into
 * candidates by the BM25 searcher's {@link MemoizingBm25CodeSymbolSearcher.rankHits}:
 * the same corpus (documentation paths excluded, #1003), the same searcher
 * options (test code, subject rules, shared terms, floor), and the same
 * absolute confidence ({@link linkConfidence}), here with the cosine.
 *
 * COST. One query embedding per distinct requirement text, on the local
 * embedder: no LLM call. A searcher instance memoizes the hybrid hits per
 * query, so the analysis path's two readings of one requirement (links and
 * seeds) embed it once.
 */
import type { PrismaClient } from "@prisma/client";
import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";
import { getEmbedder } from "../rag/embedder.js";
import {
  HybridCodeSearch,
  type HybridSearchOptions,
  type HybridSearchResult,
} from "../code-graph/hybrid-search.js";
import {
  createRunScopedSymbolIndex,
  prismaSymbolIndex,
} from "../code-graph/project-code-searcher.js";
import { createSymbolVectorStore, PENDING_MODEL } from "../code-graph/symbol-embedding-service.js";
import {
  COSINE_CALIBRATED_MODELS,
  DEFAULT_TOP_K,
  MemoizingBm25CodeSymbolSearcher,
  type Bm25SearcherOptions,
  type CodeSymbolCandidate,
  type CodeSymbolSearchOptions,
  type CodeSymbolSearcher,
  type KeywordRuleCause,
  type RankedHit,
} from "./requirement-code-mapping.js";

const log = createChildLogger("requirement-code-searcher");

/**
 * Hybrid hits read per requirement before the searcher's options and the
 * limit are applied. Wide enough that the analysis path's link rules, which
 * drop most hits, still have candidates left; the vector store is asked for
 * twice this.
 */
export const HYBRID_CANDIDATE_POOL = 60;

/**
 * #1330 — `CodeSymbol` kinds that are never embedded: the database schema's
 * tables and columns (`schema-graph.ts`), which sit in both search corpora but
 * get no `CodeSymbolEmbedding` row (only parsed code does, `ingest.ts`). A hit
 * of these kinds without a cosine is permanent, not a project still embedding.
 */
export const NEVER_EMBEDDED_KINDS: ReadonlySet<string> = new Set(["table", "column"]);

/**
 * #1417 — the `CodeSymbolEmbedding.embeddingModel` of each of `symbolIds` that
 * has a row (`""` while its embedding is pending); a symbol with no row is
 * absent. One batched read per hybrid answer.
 */
export type EmbeddingModelLookup = (
  projectId: string,
  symbolIds: readonly string[],
) => Promise<ReadonlyMap<string, string>>;

/** The {@link EmbeddingModelLookup} over a Prisma client. */
export function prismaEmbeddingModels(
  client: Pick<PrismaClient, "codeSymbolEmbedding">,
): EmbeddingModelLookup {
  return async (projectId, symbolIds) => {
    const rows = await client.codeSymbolEmbedding.findMany({
      where: { projectId, symbolId: { in: [...symbolIds] } },
      select: { symbolId: true, embeddingModel: true },
    });
    return new Map(rows.map((r) => [r.symbolId, r.embeddingModel]));
  };
}

/** The slice of {@link HybridCodeSearch} the mapper reads. */
export interface HybridRanker {
  search(
    query: string,
    projectId: string,
    opts?: HybridSearchOptions,
  ): Promise<HybridSearchResult[]>;
}

export interface HybridCodeSymbolSearcherDeps {
  /** The BM25 searcher, with the options of the keyword FALLBACK. */
  bm25: MemoizingBm25CodeSymbolSearcher;
  /**
   * The options hybrid hits are turned into candidates under. Default: the
   * fallback's (`bm25`'s). They differ on the analysis path, where the rules
   * that suit one ranking cost the other its right links
   * (`ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS`).
   */
  hybridOptions?: Bm25SearcherOptions;
  /** The hybrid ranking. */
  hybrid: HybridRanker;
  /**
   * The model id of the active SEMANTIC embedder, or `null` when there is none
   * (the hash stub is not one). Read per search, so a fallback at load time is seen.
   */
  semanticModel: () => string | null;
  /**
   * #1417 — reads the embedding rows of the hits the vector channel did not
   * return, to tell "no vector under the active model" from "a vector the
   * search lost". Absent (a test double, the eval harness): their cause is
   * not known (`no-vector`) and they are gated by the keyword rule, as under
   * #1330. FAILING: any code hit among them may be a lost vector, so each is
   * bounded and capped like one (see the module comment) rather than scored
   * on words alone, which would let a lost two-word hit read 0.273; a table
   * or column is never embedded and stays with the keyword rule. With no
   * returned cosine to bound them, they go to the keyword rule (`no-vector`).
   */
  embeddingModels?: EmbeddingModelLookup;
}

/** #1417 — what the embedding rows say of a hit left with no cosine. */
type VectorState = "pending" | "other-model" | "none" | "unknown";

interface HybridAnswer {
  hits: RankedHit[];
  /**
   * Whether the active model's cosines are calibrated (`COSINE_CALIBRATED_MODELS`).
   * An uncalibrated answer gives the confidence no semantic evidence, so its
   * links are shown under the KEYWORD fallback's rules (review of PR #1325).
   * A calibrated answer's hits without a cosine are, hit by hit (#1330).
   */
  calibrated: boolean;
  /** #1417 — of each calibrated hit still without a cosine, why it has none. */
  vectorState: ReadonlyMap<string, VectorState>;
  /**
   * #1417 — hits given the lowest returned cosine as an upper bound (a vector
   * the search lost, or any unscored hit when the rows could not be read).
   */
  bounded: ReadonlySet<string>;
}

/**
 * A {@link CodeSymbolSearcher} that ranks with the hybrid search and falls back
 * to BM25 (see the module comment).
 */
export class HybridCodeSymbolSearcher implements CodeSymbolSearcher {
  constructor(
    private readonly deps: HybridCodeSymbolSearcherDeps,
    /** Hybrid answers per project and query, shared by {@link withOptions} siblings. */
    private readonly answers = new Map<string, Promise<HybridAnswer | null>>(),
  ) {}

  /**
   * A searcher over the same corpus and the same hybrid answers with other
   * options — the analysis path reads one requirement twice (#1063).
   * `options` apply to the keyword fallback, `hybridOptions` (default: the
   * same) to the hybrid ranking.
   */
  withOptions(
    options: Bm25SearcherOptions,
    hybridOptions: Bm25SearcherOptions = options,
  ): HybridCodeSymbolSearcher {
    return new HybridCodeSymbolSearcher(
      { ...this.deps, bm25: this.deps.bm25.withOptions(options), hybridOptions },
      this.answers,
    );
  }

  /** #921 — whether the project has a code graph (loads the BM25 corpus once; throws when it cannot be read). */
  loadsCodeGraph(projectId: string): Promise<boolean> {
    return this.deps.bm25.loadsCodeGraph(projectId);
  }

  /** Whether a project this instance already searched has a code graph (#1063). */
  hasCodeGraph(projectId: string): Promise<boolean> {
    return this.deps.bm25.hasCodeGraph(projectId);
  }

  async search(
    query: string,
    projectId: string,
    opts: CodeSymbolSearchOptions = {},
  ): Promise<CodeSymbolCandidate[]> {
    const limit = opts.limit ?? DEFAULT_TOP_K;
    const answer = await this.answer(query, projectId);
    if (!answer) {
      const candidates = await this.deps.bm25.search(query, projectId, {
        limit,
        onRetrievalMode: opts.onRetrievalMode,
      });
      opts.onLinkGate?.("keyword");
      return candidates;
    }
    opts.onRetrievalMode?.("hybrid");
    // An uncalibrated answer ranks, but its links are gated as keywords: the
    // hybrid floor alone would show any one-shared-word symbol (the #1095 shape).
    if (!answer.calibrated) {
      const candidates = await this.deps.bm25.rankHits(query, projectId, answer.hits, limit);
      opts.onLinkGate?.("keyword", "uncalibrated-model");
      return candidates.map((c) => ({
        ...c,
        linkGate: "keyword" as const,
        keywordRuleCause: "uncalibrated-model" as const,
      }));
    }
    // #1330 — hit by hit: a hit with a cosine under the hybrid options, a hit
    // with no vector under the keyword fallback's. #1417 — each candidate says
    // which, and why the keyword rule decided it, so a caller can read the
    // cause of the links it SHOWS (after its own floor and top-K).
    const hybridRanker = this.deps.hybridOptions
      ? this.deps.bm25.withOptions(this.deps.hybridOptions)
      : this.deps.bm25;
    const measured = answer.hits.filter((h) => h.cosine != null && !answer.bounded.has(h.symbolId));
    const bounded = answer.hits.filter((h) => answer.bounded.has(h.symbolId));
    const unscored = answer.hits.filter((h) => h.cosine == null);
    const byConfidence = (await hybridRanker.rankHits(query, projectId, measured, limit)).map(
      (c) => ({ ...c, linkGate: "hybrid" as const }),
    );
    const byBound =
      bounded.length > 0
        ? capBelowMeasured(
            await hybridRanker.rankHits(query, projectId, bounded, limit),
            byConfidence,
            hybridRanker.minConfidence,
          )
        : [];
    const byKeyword =
      unscored.length > 0
        ? (await this.deps.bm25.rankHits(query, projectId, unscored, limit)).map((c) => ({
            ...c,
            linkGate: "keyword" as const,
            keywordRuleCause: keywordRuleCauseOf(c, answer.vectorState),
          }))
        : [];
    opts.onLinkGate?.("hybrid");
    // #1417 — `limit` is honoured in the order the mapper reads candidates in
    // (confidence, highest first; a stable sort keeps the fused order on a
    // tie), so the cut never drops a candidate the mapper would rank above
    // one it keeps.
    return [...byConfidence, ...byBound, ...byKeyword]
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .slice(0, limit);
  }

  /** The hybrid hits for a query, or `null` when the mapper must fall back. */
  private answer(query: string, projectId: string): Promise<HybridAnswer | null> {
    const key = JSON.stringify([projectId, query]);
    let answer = this.answers.get(key);
    if (!answer) {
      answer = this.askHybrid(query, projectId);
      this.answers.set(key, answer);
    }
    return answer;
  }

  private async askHybrid(query: string, projectId: string): Promise<HybridAnswer | null> {
    const model = this.deps.semanticModel();
    if (!model) return null;
    let mode = "bm25-only" as "hybrid" | "bm25-only";
    let results: HybridSearchResult[];
    try {
      results = await this.deps.hybrid.search(query, projectId, {
        limit: HYBRID_CANDIDATE_POOL,
        onRetrievalMode: (m) => {
          mode = m;
        },
      });
    } catch (err) {
      log.warn("hybrid code search failed; mapping with BM25", {
        projectId,
        error: String(err),
      });
      return null;
    }
    if (mode !== "hybrid") return null;
    // Another model's cosines are on another scale: rank with them, but score
    // the confidence on the lexical evidence alone (and gate it as keywords).
    const calibrated = COSINE_CALIBRATED_MODELS.has(model);
    const hits: RankedHit[] = results.map((r) => ({
      symbolId: r.symbolId,
      score: r.score,
      cosine:
        calibrated && typeof r.vectorScore === "number" && Number.isFinite(r.vectorScore)
          ? r.vectorScore
          : null,
    }));
    const vectorState = new Map<string, VectorState>();
    const bounded = new Set<string>();
    if (!calibrated) return { calibrated, hits, vectorState, bounded };
    // #1330 / #1417 — a hit the vector channel did not return has no cosine.
    // Under the 0.05 / 0.95 fusion every vector hit outranks every
    // keyword-only one, so such a hit reaches the pool only when fewer vector
    // hits survived than the pool holds. Its embedding row says why:
    //   - a row under the active model: it HAS a vector, which the search lost
    //     (stale symbols' rows crowded it out, or another model's rows were
    //     filtered after the search). It ranked past every returned vector
    //     hit, so the lowest returned cosine is an upper bound on its own
    //     (#1325; exact only under an exact search): scored there, then capped
    //     below every measured link (see `search`);
    //   - a pending row, another model's row, or none (a table or column is
    //     never embedded): it has no vector to compare, so it is left to the
    //     keyword rule (see `search`);
    //   - rows that could not be read: any of these hits may be a lost vector,
    //     so each is bounded and capped like one, except a table or column
    //     (by the search's own `kind`), which is never embedded and so stays
    //     with the keyword rule (`schema-not-embedded`).
    const unscored = hits.filter((h) => h.cosine == null);
    if (unscored.length === 0) return { calibrated, hits, vectorState, bounded };
    const tags = await this.embeddingModelsOf(
      projectId,
      unscored.map((h) => h.symbolId),
    );
    const cutoff = lowestCosine(hits);
    const kinds = new Map(results.map((r) => [r.symbolId, r.kind]));
    const out = hits.map((h) => {
      if (h.cosine != null) return h;
      const tag = tags instanceof Map ? tags.get(h.symbolId) : undefined;
      const lost =
        (tags === "failed" && !NEVER_EMBEDDED_KINDS.has(kinds.get(h.symbolId) ?? "")) ||
        (tags instanceof Map && tag === model);
      if (lost && cutoff !== null) {
        bounded.add(h.symbolId);
        return { ...h, cosine: cutoff };
      }
      vectorState.set(h.symbolId, vectorStateOf(tags instanceof Map ? tags : null, tag, model));
      return h;
    });
    return { calibrated, hits: out, vectorState, bounded };
  }

  /**
   * The hits' embedding-row tags; `"absent"` with no lookup, `"failed"` when
   * the rows could not be read.
   */
  private async embeddingModelsOf(
    projectId: string,
    symbolIds: readonly string[],
  ): Promise<ReadonlyMap<string, string> | "absent" | "failed"> {
    if (!this.deps.embeddingModels) return "absent";
    try {
      return await this.deps.embeddingModels(projectId, symbolIds);
    } catch (err) {
      log.warn("could not read the hits' embedding rows; capping them as lost vectors", {
        projectId,
        error: String(err),
      });
      return "failed";
    }
  }
}

/**
 * #1417 — a bounded hit's confidence, capped strictly below the lowest
 * confidence of the measured candidates kept (one step of the confidence's
 * 0.001 rounding), so it never ranks above a measured link. None is kept
 * when no measured candidate is, or when the cap takes it under the floor.
 */
export function capBelowMeasured(
  boundedCandidates: readonly CodeSymbolCandidate[],
  measured: readonly CodeSymbolCandidate[],
  floor: number | undefined,
): CodeSymbolCandidate[] {
  if (measured.length === 0) return [];
  const lowest = Math.min(...measured.map((c) => c.confidence ?? 0));
  const ceiling = Math.round((lowest - 0.001) * 1000) / 1000;
  const min = floor ?? Number.EPSILON;
  return boundedCandidates
    .map((c) => ({
      ...c,
      confidence: Math.min(c.confidence ?? 0, ceiling),
      linkGate: "hybrid" as const,
    }))
    .filter((c) => c.confidence >= min);
}

/** The lowest calibrated cosine among the vector channel's hits, or `null`. */
function lowestCosine(hits: readonly RankedHit[]): number | null {
  let low: number | null = null;
  for (const h of hits) {
    if (h.cosine != null && (low === null || h.cosine < low)) low = h.cosine;
  }
  return low;
}

/** #1417 — a hit left without a cosine, read from its embedding row's tag. */
function vectorStateOf(
  tags: ReadonlyMap<string, string> | null,
  tag: string | undefined,
  model: string,
): VectorState {
  if (!tags) return "unknown";
  if (tag === undefined) return "none";
  if (tag === PENDING_MODEL) return "pending";
  // An active-model row reaches here only with no returned cosine to bound it.
  return tag === model ? "unknown" : "other-model";
}

/** #1417 — why the keyword rule decided a candidate left without a cosine. */
function keywordRuleCauseOf(
  c: CodeSymbolCandidate,
  states: ReadonlyMap<string, VectorState>,
): KeywordRuleCause {
  if (NEVER_EMBEDDED_KINDS.has(c.kind)) return "schema-not-embedded";
  switch (states.get(c.symbolId ?? "")) {
    case "pending":
      return "embedding-pending";
    case "other-model":
      return "other-model";
    case "none":
      return "not-embedded";
    default:
      return "no-vector";
  }
}

/** The active semantic embedder's model id, or `null` when only the hash stub is available. */
export function activeSemanticModel(): string | null {
  // `AI_OFFLINE`, `EMBED_BACKEND=offline` and an opted-in hash fallback all
  // leave the `offline` backend serving.
  const embedder = getEmbedder();
  return embedder.key === "offline" ? null : embedder.model;
}

/**
 * #1097 — the production requirement→code searcher: hybrid ranking over the
 * project's symbol embeddings, falling back to the memoizing BM25 searcher.
 * One instance per mapping pass (one corpus load, one embedding per query).
 *
 * `prisma` is the client the symbols are read from; the production client
 * keeps the shared, fingerprinted symbol index, any other gets its own (the
 * same rule as Impact Analysis's `defaultSeedChange`).
 */
export function createRequirementCodeSearcher(
  prisma: Pick<PrismaClient, "codeSymbol"> & Partial<Pick<PrismaClient, "codeSymbolEmbedding">>,
  options: Bm25SearcherOptions = {},
): HybridCodeSymbolSearcher {
  const sameClient = (prisma as unknown) === (defaultPrisma as unknown);
  // #1417 — a client without the embedding rows (a test double) leaves the
  // cause of a hit with no cosine unknown, as before.
  const embeddingClient = prisma.codeSymbolEmbedding
    ? (prisma as Pick<PrismaClient, "codeSymbolEmbedding">)
    : null;
  const hybrid = new HybridCodeSearch(
    createSymbolVectorStore(),
    sameClient ? prismaSymbolIndex : createRunScopedSymbolIndex(prisma),
    getEmbedder(),
  );
  return new HybridCodeSymbolSearcher({
    bm25: new MemoizingBm25CodeSymbolSearcher(prisma, options),
    hybrid,
    semanticModel: activeSemanticModel,
    ...(embeddingClient ? { embeddingModels: prismaEmbeddingModels(embeddingClient) } : {}),
  });
}
