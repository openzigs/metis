/**
 * Issue #1837 — the verifier arm is scored the way the API runs it: below the
 * floor nothing is sent, an unreadable reply keeps the threshold label.
 */
import { describe, expect, it, vi } from "vitest";
import { renderVerifierArmReport, runVerifierArm } from "./verifier-arm.js";
import type { RequirementPair, ScoredPair } from "./calibration.js";
import { labelForScore } from "../../requirements/requirement-similarity-config.js";

const pair = (
  id: string,
  label: RequirementPair["label"],
  hardNegative = false,
): RequirementPair => ({
  id,
  domain: "d",
  label,
  ...(hardNegative ? { hardNegative } : {}),
  a: { title: `${id} a`, body: "" },
  b: { title: `${id} b`, body: "" },
});
const scoredOf = (p: RequirementPair, score: number): ScoredPair => ({
  id: p.id,
  domain: p.domain,
  label: p.label,
  hardNegative: p.hardNegative === true,
  score,
});

describe("runVerifierArm", () => {
  const pairs = [
    pair("dup", "duplicate"),
    pair("hard", "related", true),
    pair("ovl", "overlap"),
    pair("far", "unrelated"),
  ];
  const scored = [
    scoredOf(pairs[0]!, 0.85),
    scoredOf(pairs[1]!, 0.9),
    scoredOf(pairs[2]!, 0.79),
    scoredOf(pairs[3]!, 0.3),
  ];

  it("scores both arms on the same pairs and sends nothing below the floor", async () => {
    const verifier = vi.fn(async (_q: string, [c]: readonly string[]) => {
      if (c === "hard b") return ["related" as const];
      if (c === "ovl b") return null; // unreadable: keeps the threshold label (overlap)
      return ["duplicate" as const];
    });
    const report = await runVerifierArm(pairs, scored, verifier);
    expect(verifier).toHaveBeenCalledTimes(3);
    expect(verifier.mock.calls.map((c) => c[1][0])).not.toContain("far b");
    expect(report).toMatchObject({ pairs: 4, verified: 3, unreadable: 1 });

    const [threshold, verified] = report.arms;
    expect(threshold.duplicate).toMatchObject({
      truePositives: 1,
      falsePositives: 1,
      precision: 0.5,
    });
    expect(threshold.hardNegativesAsDuplicate).toEqual(["hard"]);
    expect(verified.duplicate).toMatchObject({
      truePositives: 1,
      falsePositives: 0,
      precision: 1,
      recall: 1,
    });
    expect(verified.duplicateOrOverlap).toMatchObject({ truePositives: 2, recall: 1 });
    expect(verified.hardNegativesAsDuplicate).toEqual([]);

    const md = renderVerifierArmReport(report, "deepseek-flash");
    expect(md).toContain("`deepseek-flash`): 3 of 4 pairs");
    expect(md).toContain("| threshold + verifier | 1.000 | 1.000 |");
  });

  it("counts a verifier that throws as unreadable", async () => {
    const report = await runVerifierArm(pairs, scored, async () => {
      throw new Error("529");
    });
    expect(report.unreadable).toBe(3);
    expect(report.arms[1].duplicate).toEqual(report.arms[0].duplicate);
  });

  it("labels by the committed thresholds", () => {
    expect(labelForScore(0.8)).toBe("duplicate");
    expect(labelForScore(0.79)).toBe("overlap");
    expect(labelForScore(0.7)).toBe("related");
    expect(labelForScore(0.64)).toBeNull();
  });
});
