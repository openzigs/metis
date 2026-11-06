/**
 * Issue #1837 — the LLM verifier arm, measured on #1836's labelled pairs.
 *
 * #1836 found the embedding threshold alone a poor final judge (duplicate
 * precision 0.48), so #1837 ships the verifier behind `REQ_SIMILARITY_VERIFIER`
 * and this measures it the way production would run it: a pair below the
 * `related` floor is never shown (and never sent); every other pair's second
 * requirement is labelled against its first by the verifier; an unreadable reply
 * keeps the threshold label, exactly as the API does. Both arms are scored on
 * the same pairs, for `duplicate` and for `duplicate or overlap`.
 */
import type { SimilarRequirementLabel } from "@metis/shared";
import {
  labelForScore,
  REQUIREMENT_SIMILARITY_THRESHOLDS,
  type RequirementSimilarityThresholds,
} from "../../requirements/requirement-similarity-config.js";
import type { SimilarityVerifier } from "../../requirements/similarity-verifier.js";
import {
  pairRequirementText,
  type PairLabel,
  type RequirementPair,
  type ScoredPair,
} from "./calibration.js";

type Predicted = SimilarRequirementLabel | "unrelated";

export interface ArmScore {
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number | null;
  recall: number;
}

export interface ArmResult {
  arm: "threshold" | "threshold + verifier";
  duplicate: ArmScore;
  duplicateOrOverlap: ArmScore;
  /** Hard negatives the arm labels `duplicate`. */
  hardNegativesAsDuplicate: string[];
}

export interface VerifierArmReport {
  pairs: number;
  /** Pairs at or above the floor, i.e. sent to the verifier. */
  verified: number;
  /** Replies the verifier could not give or that could not be read. */
  unreadable: number;
  arms: [ArmResult, ArmResult];
}

function score(
  scored: readonly ScoredPair[],
  predicted: ReadonlyMap<string, Predicted>,
  positive: ReadonlySet<PairLabel>,
): ArmScore {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const s of scored) {
    const isPositive = positive.has(s.label);
    const said = positive.has(predicted.get(s.id) as PairLabel);
    if (said && isPositive) tp += 1;
    else if (said) fp += 1;
    else if (isPositive) fn += 1;
  }
  return {
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
    precision: tp + fp === 0 ? null : tp / (tp + fp),
    recall: tp + fn === 0 ? 0 : tp / (tp + fn),
  };
}

function arm(
  name: ArmResult["arm"],
  scored: readonly ScoredPair[],
  predicted: ReadonlyMap<string, Predicted>,
): ArmResult {
  return {
    arm: name,
    duplicate: score(scored, predicted, new Set(["duplicate"])),
    duplicateOrOverlap: score(scored, predicted, new Set(["duplicate", "overlap"])),
    hardNegativesAsDuplicate: scored
      .filter((s) => s.hardNegative && predicted.get(s.id) === "duplicate")
      .map((s) => s.id),
  };
}

/** Score the threshold arm and the threshold + verifier arm on the same pairs. */
export async function runVerifierArm(
  pairs: readonly RequirementPair[],
  scored: readonly ScoredPair[],
  verifier: SimilarityVerifier,
  thresholds: RequirementSimilarityThresholds = REQUIREMENT_SIMILARITY_THRESHOLDS,
): Promise<VerifierArmReport> {
  const byId = new Map(pairs.map((p) => [p.id, p]));
  const threshold = new Map<string, Predicted>();
  const verified = new Map<string, Predicted>();
  let sent = 0;
  let unreadable = 0;
  for (const s of scored) {
    const label = labelForScore(s.score, thresholds) ?? "unrelated";
    threshold.set(s.id, label);
    if (label === "unrelated") {
      verified.set(s.id, "unrelated");
      continue;
    }
    const pair = byId.get(s.id) as RequirementPair;
    sent += 1;
    const reply = await verifier(pairRequirementText(pair.a), [pairRequirementText(pair.b)]).catch(
      () => null,
    );
    if (!reply) unreadable += 1;
    verified.set(s.id, reply?.[0] ?? label);
  }
  return {
    pairs: scored.length,
    verified: sent,
    unreadable,
    arms: [arm("threshold", scored, threshold), arm("threshold + verifier", scored, verified)],
  };
}

const p3 = (n: number | null): string => (n === null ? "—" : n.toFixed(3));

export function renderVerifierArmReport(report: VerifierArmReport, model: string): string {
  const lines = [
    `### Verifier arm (\`${model}\`): ${report.verified} of ${report.pairs} pairs at or above the floor sent, ${report.unreadable} unreadable`,
    "",
    "| arm | duplicate P | duplicate R | dup-or-overlap P | dup-or-overlap R | hard negatives labelled duplicate |",
    "|---|---|---|---|---|---|",
  ];
  for (const a of report.arms) {
    lines.push(
      `| ${a.arm} | ${p3(a.duplicate.precision)} | ${a.duplicate.recall.toFixed(3)} | ${p3(a.duplicateOrOverlap.precision)} | ${a.duplicateOrOverlap.recall.toFixed(3)} | ${a.hardNegativesAsDuplicate.length} |`,
    );
  }
  return lines.join("\n");
}
