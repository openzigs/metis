/**
 * Epic #1156 / Issue #1158 — the cross-encoder rerank stage, as an EVAL-ONLY decorator.
 *
 * ## Why this lives in `lib/eval/` and not in `lib/code-graph/`
 *
 * #1158 asked for the stage to be wired into `HybridCodeSearch.search`, measured, and
 * then decided. It was wired, it was measured, and the measurement is a clear negative:
 * on `embedretrieval-02-nl-to-code` the cross-encoder moves nDCG@10 **0.276 → 0.218 /
 * 0.182 / 0.160** at pool depths 20 / 50 / 100, monotonically worse the deeper the pool,
 * for 93 / 266 / 541 ms of added p50 latency per query. The issue's stop condition for
 * that outcome is unambiguous:
 *
 * > Revert the wiring... Do **not** leave a dormant rerank stage in the code path "for
 * > later" — dead flag-gated stages are how the reranker came to be simultaneously
 * > built, off, and forgotten in the first place.
 *
 * So the production wiring was reverted: `grep -rn "rerank" server/src/lib/code-graph/`
 * returns nothing again, and `createDefaultCodeSearcher` never constructs a reranker.
 *
 * What is kept is this — the stage as an eval decorator — so the negative result stays
 * **reproducible**. A committed number nobody can re-derive is a claim, not evidence,
 * and the next person to ask "should we rerank?" needs to be able to re-run it rather
 * than rebuild the apparatus and, in rebuilding it, re-introduce the defect #1158 found.
 * Nothing here is reachable from `server/src/routes`, `server/src/lib/analysis` or any
 * other production path; it is only ever constructed by `eval-embed-retrieval.ts`.
 *
 * ## It reproduces what was wired, with one deliberate difference
 *
 * The reverted production wiring gave the cross-encoder the persisted
 * `CodeSymbolEmbedding.text` for candidates the VECTOR channel returned, and the
 * one-line `formatSymbolForEmbedding` header for candidates only BM25 found (production
 * carries no `signature`/`docstring` on `SearchableSymbol` — epic #1156, finding (a)).
 * A decorator over `FusedCodeSearcher` cannot see which channel produced a hit, so it
 * gives EVERY candidate the full index-time text when the corpus has one.
 *
 * That difference is deliberate and it is the conservative direction: it is the most
 * favourable passage set the cross-encoder could be handed, so a negative measured
 * under it is a stronger negative, not a weaker one.
 */
import type { FusedCodeSearcher, RawCodeSymbolHit } from "../../rag/fused-code-context.js";
import { formatSymbolForEmbedding, type SymbolKind } from "../../code-graph/symbol-embeddings.js";
import { createChildLogger } from "../../logger.js";
import type { RerankCandidate, Reranker } from "../../rag/reranker.js";
import type { EmbedRetrievalCorpus } from "./corpus.js";

const log = createChildLogger("eval-rerank-searcher");

/**
 * Passage text per symbol id, from {@link formatSymbolForEmbedding} and nothing else.
 *
 * `CodeSymbolEmbedding.text` is documented as the production index-time text, and
 * `formatSymbolForEmbedding` returns a pre-formatted `text` VERBATIM — that
 * short-circuit is the documented way to replay what a symbol was embedded from. So a
 * symbol with a corpus doc is reranked on exactly the bytes it was embedded from, and a
 * symbol without one (the SQL symbols, which production never embeds) is formatted by
 * the SAME function from the same fields production has. There is no second formatter.
 */
export function buildPassageTexts(corpus: EmbedRetrievalCorpus): Map<string, string> {
  const byId = new Map<string, string>();
  for (const doc of corpus.docs) byId.set(doc.id, doc.text);

  const out = new Map<string, string>();
  for (const sym of corpus.symbols) {
    out.set(
      sym.id,
      formatSymbolForEmbedding({
        symbolId: sym.id,
        name: sym.name,
        qualifiedName: sym.qualifiedName,
        kind: sym.kind as SymbolKind,
        filePath: sym.filePath,
        text: byId.get(sym.id),
      }),
    );
  }
  return out;
}

export interface RerankingSearcherOptions {
  /** Candidates fetched from the base searcher before the trim back to `limit`. */
  poolSize: number;
  /** Passage text per symbol id — see {@link buildPassageTexts}. */
  passages: ReadonlyMap<string, string>;
}

/**
 * Wrap a searcher with a cross-encoder rerank stage: widen → rerank → trim.
 *
 * The widen is the whole point. A cross-encoder over exactly `limit` candidates can
 * reorder the answer but can never recover a symbol fusion placed at rank `limit + 1`,
 * so the pool depth IS the experiment. Passing `poolSize` as the base searcher's
 * `limit` also widens its vector fetch (`limit * 2` inside `HybridCodeSearch`), which
 * is what production's document path does too.
 *
 * **Degradation.** `reranker.ts` promises that a missing or corrupt model "falls
 * through transparently"; this decorator INHERITS that rather than assuming it. A
 * reranker that rejects, returns nothing, drops candidates or invents ids leaves the
 * fused ordering intact and never throws into the caller.
 */
export function createRerankingSearcher(
  base: FusedCodeSearcher,
  reranker: Reranker,
  opts: RerankingSearcherOptions,
): FusedCodeSearcher {
  const { poolSize, passages } = opts;
  return {
    async search(query, projectId, searchOpts): Promise<RawCodeSymbolHit[]> {
      const limit = searchOpts?.limit ?? 20;
      const pool = await base.search(query, projectId, {
        ...searchOpts,
        limit: Math.max(poolSize, limit),
      });
      if (pool.length === 0) return pool;

      const candidates: RerankCandidate[] = pool.map((hit) => ({
        chunkId: hit.symbolId,
        text: passages.get(hit.symbolId) ?? `${hit.kind} ${hit.name} in ${hit.filePath}`,
        score: hit.score,
      }));

      let reordered: RerankCandidate[];
      try {
        reordered = await reranker.rerank(query, candidates);
      } catch (err) {
        log.warn("rerank stage failed, keeping the fused ordering", { error: String(err) });
        return pool.slice(0, limit);
      }
      if (!Array.isArray(reordered) || reordered.length === 0) return pool.slice(0, limit);

      const byId = new Map(pool.map((h) => [h.symbolId, h]));
      const out: RawCodeSymbolHit[] = [];
      const seen = new Set<string>();
      for (const r of reordered) {
        const hit = byId.get(r.chunkId);
        // An id the reranker invented is dropped, not trusted.
        if (!hit || seen.has(r.chunkId)) continue;
        seen.add(r.chunkId);
        out.push({ ...hit, score: r.score ?? hit.score });
      }
      // Anything the reranker failed to return keeps its fused position behind the rest,
      // so a lossy reranker cannot silently shorten the result list.
      for (const hit of pool) {
        if (!seen.has(hit.symbolId)) out.push(hit);
      }
      return out.slice(0, limit);
    },
  };
}
