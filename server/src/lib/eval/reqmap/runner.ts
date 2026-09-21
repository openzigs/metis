/**
 * Epic #726 / Issue #738 — requirement→code mapping precision/recall eval
 * runner.
 *
 * For each replayed-PR case, run the SAME deterministic B2 path the analysis
 * "Evaluate new requirements" flow uses (#735): `mapRequirementToCode` (BM25
 * seed set) expanded by `blastRadius`, composed via `computeProjectImpact`. The
 * predicted affected-file set is scored against the PR's actually-changed files
 * with the pure {@link scoreCase} scorer.
 *
 * The runner is pure orchestration over injected fixture pieces (no process.env
 * reads, no network, no DB) so the CI unit test and the offline CLI drive it
 * identically and deterministically.
 */
import { computeProjectImpact } from "../../impact-analysis/impact-analysis-engine.js";
import type { ChangedRequirement } from "../../impact-analysis/extract-changes.js";
import { mapRequirementToCode } from "../../traceability/requirement-code-mapping.js";
import { aggregateScores, scoreCase, type AggregateScore, type CaseScore } from "./scorer.js";
import type { ReqMapCase, ReqMapFixture } from "./fixture.js";

export interface ReqMapEvalResult {
  scores: CaseScore[];
  aggregate: AggregateScore;
}

/**
 * Regression floors for the aggregate scores. These are set BELOW the measured
 * performance on the committed fixture (macroF1 0.81, macroRecall 1.0, microF1
 * 0.77, hitRate 1.0 as of the #738 fixture) with deliberate headroom, so the
 * eval fails only on a genuine mapping regression — not on noise. Recall is
 * floored high because the mapping's job is to FIND the files that changed;
 * precision is floored lower because BM25 + blast-radius over-predict on a tiny
 * fixture (a known, tolerated trade-off). Raise these as the mapper improves.
 */
export const REQMAP_EVAL_THRESHOLDS = {
  macroF1: 0.7,
  macroRecall: 0.8,
  microF1: 0.6,
  hitRate: 0.8,
} as const;

export type ReqMapThresholds = typeof REQMAP_EVAL_THRESHOLDS;

export interface ThresholdCheck {
  metric: keyof ReqMapThresholds;
  floor: number;
  value: number;
  passed: boolean;
}

/**
 * Compare an aggregate against the regression floors. Pure — returns a per-
 * metric breakdown and an overall pass so the CI test and the CLI agree on
 * exactly what "regressed" means.
 */
export function checkThresholds(
  aggregate: AggregateScore,
  thresholds: ReqMapThresholds = REQMAP_EVAL_THRESHOLDS,
): { passed: boolean; checks: ThresholdCheck[] } {
  const checks: ThresholdCheck[] = (Object.keys(thresholds) as Array<keyof ReqMapThresholds>).map(
    (metric) => {
      const floor = thresholds[metric];
      const value = aggregate[metric];
      return { metric, floor, value, passed: value >= floor };
    },
  );
  return { passed: checks.every((c) => c.passed), checks };
}

/** Turn a replayed-PR requirement string into a single `ChangedRequirement`. */
export function caseToChange(c: ReqMapCase): ChangedRequirement {
  return {
    requirementId: c.id,
    title: c.requirement,
    body: c.requirement,
    changeType: "added",
    bodyDelta: c.requirement.length,
  };
}

/**
 * Run the B2 mapping for one case and return the deterministically-ordered,
 * deduped list of predicted affected files.
 */
export async function predictAffectedFiles(
  fixture: ReqMapFixture,
  c: ReqMapCase,
): Promise<string[]> {
  const impact = await computeProjectImpact(caseToChange(c), fixture.projectId, {
    // Inject the fixture's production BM25 searcher — no DB.
    mapRequirement: (req, projectId) =>
      mapRequirementToCode(req, projectId, {}, { searcher: fixture.searcher }),
    // Inject the in-memory code graph so blastRadius walks the declared callers.
    dataSourceFor: () => fixture.dataSource,
    // Code-symbol impact only — no schema crossing in this eval.
    includeSchemaImpact: false,
  });

  // File-level prediction: the distinct files across every affected symbol,
  // preserving the impact ordering (direct hits first, then blast radius).
  const seen = new Set<string>();
  const files: string[] = [];
  for (const s of impact.affectedSymbols) {
    if (!seen.has(s.filePath)) {
      seen.add(s.filePath);
      files.push(s.filePath);
    }
  }
  return files;
}

/** Run the full eval across every fixture case and aggregate the scores. */
export async function runReqMapEval(fixture: ReqMapFixture): Promise<ReqMapEvalResult> {
  const scores: CaseScore[] = [];
  for (const c of fixture.cases) {
    const predicted = await predictAffectedFiles(fixture, c);
    scores.push(scoreCase(c.id, predicted, c.changedFiles));
  }
  return { scores, aggregate: aggregateScores(scores) };
}
