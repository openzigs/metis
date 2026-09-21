/**
 * Epic #1156 / Issue #1160 — how much of a document chunk survives the
 * cross-encoder's input budget.
 *
 * ## Why this lives here
 *
 * #1158 measured the cross-encoder on the CODE path and reverted it, but flagged a
 * question it could not answer: document chunks at 2048 characters are ≈512 tokens,
 * which is the whole input budget of `Xenova/ms-marco-MiniLM-L-6-v2`. The reranker
 * tokenizes `(query, passage)` as a PAIR with `truncation: true`
 * (`reranker.ts:222`), so the query's tokens and the two separator tokens come out
 * of the same 512, and the tail of the passage is silently cut.
 *
 * That happens on the document path behind `RAG_RERANK=1`, which #1158 correctly
 * refused to flip because no harness could see it. This one can — it is the first
 * place in the repo where real document chunks at a known chunk size exist outside
 * a running server — so the profile is measured rather than asserted.
 *
 * **This measures INPUT TRUNCATION, not rerank quality.** Whether reranking helps
 * or hurts document retrieval is #1158's deferred question and is deliberately not
 * answered here; entangling it with a chunk-size sweep would make neither
 * attributable.
 */

/** Model whose budget is being profiled — the reranker's `DEFAULT_MODEL`. */
export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/**
 * Total input budget of the cross-encoder, in tokens.
 *
 * `ms-marco-MiniLM-L-6-v2` is a BERT-family encoder with `max_position_embeddings`
 * 512. The pair is packed as `[CLS] query [SEP] passage [SEP]`, so the passage gets
 * 512 minus the query's tokens minus three specials.
 */
export const RERANK_TOKEN_BUDGET = 512;

/** Specials in a `[CLS] a [SEP] b [SEP]` pair encoding. */
export const PAIR_SPECIAL_TOKENS = 3;

/** Minimal shape of the tokenizer call this module needs. */
export type TokenCounter = (text: string) => Promise<number> | number;

/** What the cross-encoder would actually see, for one arm's chunks. */
export interface RerankBudgetProfile {
  chunkSize: number;
  chunkCount: number;
  /** Median passage length in tokens. */
  medianTokens: number;
  maxTokens: number;
  /** Chunks whose passage alone exceeds the budget left after a typical query. */
  truncatedChunks: number;
  /** `truncatedChunks / chunkCount`, in [0, 1]. */
  truncatedFraction: number;
  /** Mean fraction of each chunk's tokens that survive truncation, in [0, 1]. */
  meanSurvivingFraction: number;
  /**
   * Tokens the typical query consumed, which is budget the passage does not get.
   * The MEAN over the corpus's questions, as `wired-harness.ts` computes it.
   */
  queryTokens: number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Profile one arm's chunks against the cross-encoder's pair budget.
 *
 * `queryTokens` is the TYPICAL query length rather than a worst case: the point is
 * what a normal search does, not what an adversarial one could do.
 */
export async function profileRerankBudget(
  chunkSize: number,
  chunkTexts: readonly string[],
  countTokens: TokenCounter,
  queryTokens: number,
): Promise<RerankBudgetProfile> {
  const passageBudget = Math.max(1, RERANK_TOKEN_BUDGET - queryTokens - PAIR_SPECIAL_TOKENS);
  const tokens: number[] = [];
  for (const text of chunkTexts) tokens.push(await countTokens(text));

  const truncated = tokens.filter((t) => t > passageBudget);
  const surviving = tokens.map((t) => (t <= passageBudget ? 1 : passageBudget / t));

  return {
    chunkSize,
    chunkCount: tokens.length,
    medianTokens: median(tokens),
    maxTokens: tokens.length === 0 ? 0 : Math.max(...tokens),
    truncatedChunks: truncated.length,
    truncatedFraction: tokens.length === 0 ? 0 : truncated.length / tokens.length,
    meanSurvivingFraction:
      surviving.length === 0 ? 1 : surviving.reduce((a, b) => a + b, 0) / surviving.length,
    queryTokens,
  };
}

/** Render the truncation profiles as a section of the sweep artefact. */
export function renderRerankBudget(profiles: readonly RerankBudgetProfile[]): string {
  if (profiles.length === 0) return "";
  const lines: string[] = [];
  lines.push(`## Cross-encoder input budget (\`${RERANK_MODEL}\`, ${RERANK_TOKEN_BUDGET} tokens)`);
  lines.push("");
  lines.push(
    "Routed here from #1158's review. The reranker tokenizes `(query, passage)` as a " +
      "PAIR with `truncation: true` (`reranker.ts:222`), so query tokens and the three " +
      "specials come out of the same 512 and the passage tail is cut **silently**. This " +
      "is live behind `RAG_RERANK=1` on the document path. It measures INPUT TRUNCATION " +
      "only — whether reranking helps document retrieval is #1158's deferred question.",
  );
  lines.push("");
  lines.push(
    "| chunk chars | chunks | median tokens | max tokens | over budget | % over | mean surviving |",
  );
  lines.push("|---:|---:|---:|---:|---:|---:|---:|");
  for (const p of profiles) {
    lines.push(
      `| ${p.chunkSize} | ${p.chunkCount} | ${p.medianTokens} | ${p.maxTokens} | ` +
        `${p.truncatedChunks} | ${(p.truncatedFraction * 100).toFixed(1)}% | ` +
        `${(p.meanSurvivingFraction * 100).toFixed(1)}% |`,
    );
  }
  lines.push("");
  // "mean query", not "median query": `wired-harness.ts` computes
  // `Math.round(sum / length)` over the corpus's questions. The distinction is small
  // here and the label was simply wrong — a committed artefact must not describe a
  // statistic it did not compute.
  lines.push(
    `Passage budget used: ${RERANK_TOKEN_BUDGET} − ${profiles[0].queryTokens} (mean query) ` +
      `− ${PAIR_SPECIAL_TOKENS} specials.`,
  );
  lines.push("");
  return lines.join("\n");
}
