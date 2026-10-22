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
 *   - each HIT the vector channel did not return, hit by hit. Such a hit has
 *     no usable vector as far as this answer can tell: a database table or
 *     column (never embedded, `schema-not-embedded`), code not embedded yet,
 *     a stale vector the hybrid search dropped, or a vector of another model
 *     the store filtered out after its search (`no-vector`). Its cosine is
 *     unknown, so it is scored on words alone and shown only under the
 *     two-term rule; the measured hits beside it keep the floor.
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
import { createSymbolVectorStore } from "../code-graph/symbol-embedding-service.js";
import {
  COSINE_CALIBRATED_MODELS,
  DEFAULT_TOP_K,
  MemoizingBm25CodeSymbolSearcher,
  type Bm25SearcherOptions,
  type CodeSymbolCandidate,
  type CodeSymbolSearchOptions,
  type CodeSymbolSearcher,
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
}

interface HybridAnswer {
  hits: RankedHit[];
  /**
   * Whether the active model's cosines are calibrated (`COSINE_CALIBRATED_MODELS`).
   * An uncalibrated answer gives the confidence no semantic evidence, so its
   * links are shown under the KEYWORD fallback's rules (review of PR #1325).
   * A calibrated answer's hits without a cosine are, hit by hit (#1330).
   */
  calibrated: boolean;
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
      return candidates;
    }
    // #1330 — hit by hit: a measured hit under the hybrid options, a hit with
    // no cosine under the keyword fallback's, merged back in the fused order.
    const hybridRanker = this.deps.hybridOptions
      ? this.deps.bm25.withOptions(this.deps.hybridOptions)
      : this.deps.bm25;
    const measured = answer.hits.filter((h) => h.cosine != null);
    const unmeasured = answer.hits.filter((h) => h.cosine == null);
    const fromMeasured = await hybridRanker.rankHits(query, projectId, measured, limit);
    const fromUnmeasured =
      unmeasured.length > 0
        ? await this.deps.bm25.rankHits(query, projectId, unmeasured, limit)
        : [];
    const rank = new Map(answer.hits.map((h, i) => [h.symbolId, i]));
    const at = (c: CodeSymbolCandidate): number => rank.get(c.symbolId ?? "") ?? Infinity;
    const candidates = [...fromMeasured, ...fromUnmeasured]
      .sort((a, b) => at(a) - at(b))
      .slice(0, limit);
    const keywordGated = new Set(fromUnmeasured.map((c) => c.symbolId));
    const gatedKinds = candidates.filter((c) => keywordGated.has(c.symbolId)).map((c) => c.kind);
    opts.onLinkGate?.(
      "hybrid",
      gatedKinds.length === 0
        ? undefined
        : gatedKinds.every((k) => NEVER_EMBEDDED_KINDS.has(k))
          ? "schema-not-embedded"
          : "no-vector",
    );
    return candidates;
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
    // #1330 — a hit the vector channel did not return keeps NO cosine. Under
    // the 0.05 / 0.95 fusion every vector hit outranks every keyword-only one,
    // so a keyword-only hit reaches the pool only when fewer vector hits
    // survived than the pool holds. That is not evidence of a distant vector:
    // the hit may have none (a table or column, never embedded; code not
    // embedded yet), or one the channel lost (a stale symbol dropped after
    // the search, another model's rows filtered after it). The lowest
    // returned cosine (#1325) bounded only the last two, and only under an
    // exact search; what it was for, keeping a one-word keyword hit under the
    // floor, the two-term rule now does for every such hit (see `search`).
    return {
      calibrated,
      hits: results.map((r) => ({
        symbolId: r.symbolId,
        score: r.score,
        cosine:
          calibrated && typeof r.vectorScore === "number" && Number.isFinite(r.vectorScore)
            ? r.vectorScore
            : null,
      })),
    };
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
  prisma: Pick<PrismaClient, "codeSymbol">,
  options: Bm25SearcherOptions = {},
): HybridCodeSymbolSearcher {
  const sameClient = (prisma as unknown) === (defaultPrisma as unknown);
  const hybrid = new HybridCodeSearch(
    createSymbolVectorStore(),
    sameClient ? prismaSymbolIndex : createRunScopedSymbolIndex(prisma),
    getEmbedder(),
  );
  return new HybridCodeSymbolSearcher({
    bm25: new MemoizingBm25CodeSymbolSearcher(prisma, options),
    hybrid,
    semanticModel: activeSemanticModel,
  });
}
