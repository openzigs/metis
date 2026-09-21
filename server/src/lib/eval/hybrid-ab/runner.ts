/**
 * #335 — the hybrid A/B rollout-gate runner.
 *
 * Drives the SAME fixture corpus through both arms (baseline "all-Sonnet" and
 * candidate "local+escalation") via an injected {@link SectionEvaluator}, then
 * aggregates + gates the result. The evaluator seam is the ONLY place providers
 * are touched:
 *   - In CI/unit tests it is a deterministic mock (no live models).
 *   - Run live by an operator it wraps real docs-gen synthesis + the
 *     {@link FaithfulnessJudge}, driven by the #333/#334 env flags.
 *
 * Determinism: for a given (arm, item, section) the evaluator is called exactly
 * once, in corpus order, so a deterministic evaluator yields a deterministic
 * result. Both arms iterate the identical corpus — "same corpus" is structural.
 */
import { aggregateArm, computeDeltas, evaluateGate, resolveThresholds } from "./aggregate.js";
import type { TaggedOutcome } from "./aggregate.js";
import type {
  AbCorpusItem,
  AbEvalResult,
  AbThresholds,
  EvalArm,
  SectionEvaluator,
} from "./types.js";

const ARMS: readonly EvalArm[] = ["all-sonnet", "local-escalation"];

export interface RunAbEvalInput {
  /** The fixture corpus — the SAME items drive both arms. */
  corpus: AbCorpusItem[];
  /** The injectable provider/judge seam (mocked in CI, real when run live). */
  evaluate: SectionEvaluator;
  /** Threshold overrides merged over the documented defaults. */
  thresholds?: Partial<AbThresholds>;
  /** Clock seam for deterministic timestamps in tests. */
  now?: () => Date;
  /** Commit SHA recorded on the result envelope. */
  commit?: string | null;
}

/** Run one arm over the whole corpus, returning tier-tagged section outcomes. */
async function runArm(
  arm: EvalArm,
  corpus: AbCorpusItem[],
  evaluate: SectionEvaluator,
): Promise<TaggedOutcome[]> {
  const tagged: TaggedOutcome[] = [];
  for (const item of corpus) {
    for (const section of item.sections) {
      const outcome = await evaluate({ arm, item, section });
      tagged.push({ tier: section.tier, outcome });
    }
  }
  return tagged;
}

export async function runAbEval(input: RunAbEvalInput): Promise<AbEvalResult> {
  const nowFn = input.now ?? (() => new Date());
  const startedAt = nowFn();
  const thresholds = resolveThresholds(input.thresholds);

  const sectionCount = input.corpus.reduce((s, i) => s + i.sections.length, 0);

  // Run both arms over the IDENTICAL corpus (order preserved).
  const perArm: Partial<Record<EvalArm, TaggedOutcome[]>> = {};
  for (const arm of ARMS) {
    perArm[arm] = await runArm(arm, input.corpus, input.evaluate);
  }

  const baseline = aggregateArm(
    "all-sonnet",
    perArm["all-sonnet"] ?? [],
    thresholds.cloudCostPerToken,
  );
  const candidate = aggregateArm(
    "local-escalation",
    perArm["local-escalation"] ?? [],
    thresholds.cloudCostPerToken,
  );

  const deltas = computeDeltas(baseline, candidate);
  const verdict = evaluateGate(baseline, candidate, thresholds);
  const completedAt = nowFn();

  return {
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    itemCount: input.corpus.length,
    sectionCount,
    thresholds,
    arms: { baseline, candidate },
    deltas,
    verdict,
    commit: input.commit ?? null,
  };
}
