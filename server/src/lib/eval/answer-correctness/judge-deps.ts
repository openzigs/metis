/**
 * Epic #1316 / Issue #1338 — the JUDGING side of answer-correctness.
 *
 * #1319 shipped the metric with both dependencies stubbed out
 * (`judge: async () => null`), so every score was unverifiable by construction.
 * This module supplies the real pair — and, when no provider is configured, an
 * offline pair that is unverifiable *for a stated reason* rather than silently.
 *
 * ── NO THIRD JUDGING STACK ──────────────────────────────────────────────────
 *
 * The extractor and judge are the SAME `ClaimExtractor` +
 * {@link FaithfulnessJudge} that docs-gen has used since #273, that #1317 put
 * behind the `RagasJudge` seam (`../../rag/model-ragas-judge.ts:277-283`) and
 * that #1318 made the one shared metric
 * (`../../grounding/faithfulness-metric.ts`). Nothing here prompts a model
 * itself; it only constructs those two classes. That constraint has held
 * through #1317 and #1318 and it holds here.
 *
 * ── UNVERIFIABLE, NEVER ZERO ────────────────────────────────────────────────
 *
 * With no provider the offline pair decomposes the text into exactly one claim
 * and then declines to judge it. That routing matters: a judge that returns
 * `null` makes `scoreFaithfulness` report `verified: false`, which
 * `toFaithfulnessMetric` maps to `faithfulness: null` with the reason
 * `judge-unavailable`. An extractor that returned NO claims would instead
 * produce the reason `no-claims` — true of the extractor, and a misdiagnosis of
 * a run whose real problem is that nobody configured a provider.
 */
import type { AIProvider } from "../../ai/types.js";
import { ClaimExtractor } from "../../docs-gen/grounding/claim-extractor.js";
import { FaithfulnessJudge } from "../../docs-gen/grounding/faithfulness-judge.js";
import type { ScoreAnswerCorrectnessDeps } from "./metric.js";

/**
 * A `ScoreAnswerCorrectnessDeps` plus the provider behind it, if any.
 *
 * A union rather than two independent fields: "there is a provider" and "there
 * is no reason" are the same fact, and two fields that can disagree is one more
 * state than exists. The provider is carried out so the ANSWERS and the
 * JUDGEMENTS come from one resolution — a run whose two sides silently used
 * different providers would be unattributable.
 */
export type ResolvedJudgeDeps =
  | { deps: ScoreAnswerCorrectnessDeps; provider: AIProvider; unavailableReason: null }
  | {
      deps: ScoreAnswerCorrectnessDeps;
      provider: null;
      /**
       * The sentence that ends up in the run's NOT REPORTED reason, so "we have
       * no number" is never mistaken for "the answers were wrong".
       */
      unavailableReason: string;
    };

/** Reason text when the resolved provider turned out to be the offline stub. */
export const OFFLINE_STUB_REASON =
  "no AI provider is configured — the resolved provider is METIS's offline stub, " +
  "which returns no usable verdicts. Set real provider credentials " +
  "(e.g. AI_PROVIDER=anthropic ANTHROPIC_API_KEY=…) to score this corpus.";

/**
 * Deps that cannot judge, and say so.
 *
 * The extractor is deterministic and local — one claim, the whole text — purely
 * so the null verdict is attributable to the JUDGE. It is not a scorer and
 * never returns a number.
 */
export function offlineJudgeDeps(reason: string): ResolvedJudgeDeps {
  return {
    deps: {
      extractor: {
        decompose: async (text: string) => ({ claims: [{ claim: text.trim(), sourceIds: [] }] }),
      },
      judge: { judge: async () => null },
    },
    provider: null,
    unavailableReason: reason,
  };
}

export interface ProviderJudgeOptions {
  /** Override the provider's default model for BOTH calls. */
  model?: string;
  /** Char budget for the evidence bundle shown to the judge. */
  charBudget?: number;
  signal?: AbortSignal;
}

/**
 * Provider-backed extractor + judge, or the offline pair when the provider is
 * the stub. The stub is caught HERE rather than at the call site: an offline
 * provider produces deterministic non-answers, and scoring against those would
 * publish a mean that measures nothing.
 */
export function providerJudgeDeps(
  provider: AIProvider,
  opts: ProviderJudgeOptions = {},
): ResolvedJudgeDeps {
  if (provider.offline) return offlineJudgeDeps(OFFLINE_STUB_REASON);
  const model = opts.model ? { model: opts.model } : {};
  return {
    deps: {
      extractor: new ClaimExtractor({ provider, ...model }),
      judge: new FaithfulnessJudge({ provider, ...model }),
      ...(opts.charBudget ? { charBudget: opts.charBudget } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    provider,
    unavailableReason: null,
  };
}

/**
 * Build the deps from a provider factory, degrading to the offline pair when the
 * factory throws.
 *
 * `buildProvider` reads credentials and throws when the selected provider has
 * none. CI has none by design, and `pnpm eval:answer-correctness` must stay a
 * free, offline, exit-0 command there — so a construction failure is a REASON,
 * not a crash. It is still surfaced verbatim, because "your key is malformed"
 * and "you set no key" are different problems.
 */
export function resolveJudgeDeps(
  buildProvider: () => AIProvider,
  opts: ProviderJudgeOptions = {},
): ResolvedJudgeDeps {
  let provider: AIProvider;
  try {
    provider = buildProvider();
  } catch (err) {
    return offlineJudgeDeps(
      `no AI provider could be constructed (${err instanceof Error ? err.message : String(err)}) ` +
        "— every score would be unverifiable, so none was attempted.",
    );
  }
  return providerJudgeDeps(provider, opts);
}
