import { describe, expect, it } from "vitest";
import {
  aggregateByHardCase,
  aggregateCaseScores,
  isFlagged,
  outcomeFor,
  scoreCase,
  type CaseScore,
} from "./scorer.js";
import type { HardCaseKind } from "./corpus.js";

function score(
  id: string,
  hardCase: HardCaseKind,
  expectedSupported: boolean,
  status: CaseScore["status"],
): CaseScore {
  return scoreCase(
    {
      id,
      hardCase,
      title: id,
      expected: { supported: expectedSupported, rationale: "r" },
    },
    status,
  );
}

describe("isFlagged", () => {
  it("treats the two down-weighting verdicts as flags", () => {
    expect(isFlagged("unverified")).toBe(true);
    expect(isFlagged("could-not-verify")).toBe(true);
  });

  it("does not treat `confirmed` as a flag", () => {
    expect(isFlagged("confirmed")).toBe(false);
  });

  it("does NOT count `null` abstention as a detection", () => {
    // Load-bearing: `null` is no signal, not a negative verdict. Scoring it as a
    // detection would credit a verifier for saying nothing.
    expect(isFlagged(null)).toBe(false);
  });
});

describe("outcomeFor", () => {
  it("classifies all four confusion cells", () => {
    expect(outcomeFor(false, "unverified")).toBe("TP");
    expect(outcomeFor(false, "confirmed")).toBe("FN");
    expect(outcomeFor(true, "could-not-verify")).toBe("FP");
    expect(outcomeFor(true, "confirmed")).toBe("TN");
  });

  it("makes an abstention on an unsupported finding a MISS, not a catch", () => {
    expect(outcomeFor(false, null)).toBe("FN");
  });

  it("makes an abstention on a supported finding a true negative", () => {
    expect(outcomeFor(true, null)).toBe("TN");
  });
});

describe("aggregateCaseScores", () => {
  it("reports precision and recall separately and never blends them", () => {
    const agg = aggregateCaseScores([
      score("a", "hallucinated-citation", false, "unverified"), // TP
      score("b", "semantic-mismatch", false, "confirmed"), // FN
      score("c", "semantic-mismatch", false, null), // FN
      score("d", "well-grounded", true, "could-not-verify"), // FP
      score("e", "well-grounded", true, "confirmed"), // TN
    ]);
    expect(agg).toMatchObject({
      caseCount: 5,
      truePositives: 1,
      falseNegatives: 2,
      falsePositives: 1,
      trueNegatives: 1,
    });
    expect(agg.recall).toBeCloseTo(1 / 3, 6);
    expect(agg.precision).toBeCloseTo(1 / 2, 6);
    // No F1 / accuracy key exists — #1108 forbids a blended score.
    expect(agg).not.toHaveProperty("f1");
    expect(agg).not.toHaveProperty("accuracy");
  });

  it("reports over-flag rate as its own axis over the SUPPORTED cases only", () => {
    const agg = aggregateCaseScores([
      score("a", "well-grounded", true, "unverified"), // FP
      score("b", "well-grounded", true, "confirmed"), // TN
      score("c", "well-grounded", true, "confirmed"), // TN
      score("d", "semantic-mismatch", false, "confirmed"), // FN — must not count
    ]);
    expect(agg.overFlagRate).toBeCloseTo(1 / 3, 6);
  });

  it("reports abstention rate as a diagnostic", () => {
    const agg = aggregateCaseScores([
      score("a", "doc-only", true, null),
      score("b", "doc-only", false, null),
      score("c", "well-grounded", true, "confirmed"),
      score("d", "well-grounded", true, "confirmed"),
    ]);
    expect(agg.abstentionRate).toBeCloseTo(0.5, 6);
  });

  it("uses the documented empty-denominator convention of 1", () => {
    // No unsupported cases ⇒ nothing to detect ⇒ recall 1; nothing flagged ⇒
    // precision 1. The raw counts alongside make the vacuity visible.
    const agg = aggregateCaseScores([score("a", "well-grounded", true, "confirmed")]);
    expect(agg.recall).toBe(1);
    expect(agg.precision).toBe(1);
    expect(agg.truePositives).toBe(0);
  });

  it("returns a zero over-flag rate when there are no supported cases", () => {
    const agg = aggregateCaseScores([score("a", "semantic-mismatch", false, "confirmed")]);
    expect(agg.overFlagRate).toBe(0);
  });

  it("handles an empty score list without dividing by zero", () => {
    const agg = aggregateCaseScores([]);
    expect(agg).toMatchObject({ caseCount: 0, abstentionRate: 0, overFlagRate: 0 });
    expect(agg.recall).toBe(1);
  });
});

describe("aggregateByHardCase", () => {
  it("breaks the aggregate down per hard-case kind", () => {
    const by = aggregateByHardCase([
      score("a", "semantic-mismatch", false, "confirmed"), // FN
      score("b", "semantic-mismatch", false, "unverified"), // TP
      score("c", "well-grounded", true, "confirmed"), // TN
    ]);
    expect(Object.keys(by).sort()).toEqual(["semantic-mismatch", "well-grounded"]);
    expect(by["semantic-mismatch"].recall).toBeCloseTo(0.5, 6);
    expect(by["semantic-mismatch"].kind).toBe("semantic-mismatch");
    expect(by["well-grounded"].caseCount).toBe(1);
  });
});
