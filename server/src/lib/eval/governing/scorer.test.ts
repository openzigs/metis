import { describe, expect, it } from "vitest";
import type { GoverningItem, GoverningRule } from "./corpus.js";
import {
  aggregate,
  bootstrapRatioCi,
  checkThresholds,
  citationVerified,
  scoreItem,
  stripRuleMarker,
  summarizeRuns,
  type GoverningArmOutput,
} from "./scorer.js";

const RULES: GoverningRule[] = [
  {
    id: "AL-02",
    area: "audit-logging",
    summary: "Bulk extraction is audit-logged.",
    clause:
      "Every bulk extraction of customer or financial records is recorded in the audit trail, naming the person, the time and the scope of what was taken.",
  },
  {
    id: "EN-03",
    area: "encryption",
    summary: "No full card numbers.",
    clause:
      "Full card numbers are never stored; at most the last four digits are kept for display.",
  },
  {
    id: "DR-01",
    area: "data-retention",
    summary: "Seven years.",
    clause:
      "Financial transaction records are kept for seven years from the end of the fiscal year they belong to.",
  },
];
const corpus = { ruleById: new Map(RULES.map((r) => [r.id, r])) };

const item = (id: string, applies: GoverningItem["applies"]): GoverningItem => ({
  id,
  title: id,
  text: id,
  applies,
});
const out = (...judgements: GoverningArmOutput["judgements"]): GoverningArmOutput => ({
  judgements,
});
const VERBATIM = { ruleId: "AL-02", excerpt: "recorded in the audit trail, naming the person" };

describe("hard errors: a no-evidence outcome scored as compliant (#1867 AC)", () => {
  for (const truth of ["needs-ba-input", "gap"] as const) {
    it(`counts compliant on a ${truth} pair as a hard error, not a near miss`, () => {
      const s = scoreItem(
        corpus,
        item("R", [{ ruleId: "AL-02", verdict: truth, businessFact: "x" }]),
        out({ ruleId: "AL-02", verdict: "compliant", citation: VERBATIM }),
      );
      expect(s.hardErrors).toBe(1);
      expect(s.pairs[0]).toMatchObject({ truth, verdict: "compliant", hardError: true });
      expect(s.verdictCorrect).toBe(0);
      // Found, so recall credits it: the error is in the verdict, and it is counted apart.
      expect(s.truePositives).toBe(1);
      expect(aggregate([s]).hardErrors).toBe(1);
    });
  }

  it("does not count a wrong verdict that is not compliant (gap for needs-ba-input) as a hard error", () => {
    const s = scoreItem(
      corpus,
      item("R", [{ ruleId: "AL-02", verdict: "needs-ba-input", businessFact: "x" }]),
      out({ ruleId: "AL-02", verdict: "gap" }),
    );
    expect(s.hardErrors).toBe(0);
    expect(s.verdictCorrect).toBe(0);
  });

  it("does not count compliant on a compliant pair, or on a rule that does not apply", () => {
    const s = scoreItem(
      corpus,
      item("R", [{ ruleId: "AL-02", verdict: "compliant" }]),
      out({ ruleId: "AL-02", verdict: "compliant" }, { ruleId: "EN-03", verdict: "compliant" }),
    );
    expect(s.hardErrors).toBe(0);
    expect(s.verdictCorrect).toBe(1);
    expect(s.applied).toBe(2);
    expect(s.truePositives).toBe(1);
  });
});

describe("citation accuracy (#1867 AC)", () => {
  const scored = (excerpt: string, ruleId = "AL-02") =>
    aggregate([
      scoreItem(
        corpus,
        item("R", [{ ruleId: "AL-02", verdict: "gap" }]),
        out({ ruleId: "AL-02", verdict: "gap", citation: { ruleId, excerpt } }),
      ),
    ]);

  it("scores a paraphrased excerpt 0 for the pair", () => {
    const m = scored("each bulk export of customer records must be logged with who did it");
    expect(m.citationAccuracy).toBe(0);
    expect(m.citationCoverage).toBe(1);
  });

  it("scores a verbatim excerpt 1, whitespace aside and with the policy's own id marker", () => {
    expect(scored(VERBATIM.excerpt).citationAccuracy).toBe(1);
    expect(scored("recorded  in the\naudit trail").citationAccuracy).toBe(1);
    expect(scored("**AL-02** Every bulk extraction of customer").citationAccuracy).toBe(1);
  });

  it("scores 0 for the right words under the wrong rule id, or an excerpt too short to pin a clause", () => {
    expect(scored(VERBATIM.excerpt, "DR-01").citationAccuracy).toBe(0);
    expect(scored("the audit trail").citationAccuracy).toBe(0);
  });

  it("is a different rule's clause, not any clause: words of DR-01 do not verify an AL-02 pair", () => {
    expect(scored("kept for seven years from the end").citationAccuracy).toBe(0);
  });

  it("leaves accuracy undefined, not 0 or 1, when nothing is cited, and coverage says so", () => {
    const m = aggregate([
      scoreItem(
        corpus,
        item("R", [{ ruleId: "AL-02", verdict: "gap" }]),
        out({ ruleId: "AL-02", verdict: "gap" }),
      ),
    ]);
    expect(m.citationAccuracy).toBeNull();
    expect(m.citationCoverage).toBe(0);
  });

  it("verifies nothing for an unknown rule or no citation", () => {
    expect(
      citationVerified(corpus, "ZZ-01", { ruleId: "ZZ-01", excerpt: "anything at all here" }),
    ).toBe(false);
    expect(citationVerified(corpus, "AL-02", undefined)).toBe(false);
    expect(stripRuleMarker("AL-02: the time and")).toBe("the time and");
  });
});

describe("the non-resembling subset is computed apart from the overall number (#1867 AC)", () => {
  // R1 has a resembling rule; R2 has a non-resembling rule (AL-02) and a resembling one (DR-01).
  const items = [
    item("R1", [{ ruleId: "EN-03", verdict: "gap" }]),
    item("R2", [
      {
        ruleId: "AL-02",
        verdict: "needs-ba-input",
        businessFact: "attributed?",
        nonResembling: true,
      },
      { ruleId: "DR-01", verdict: "needs-ba-input", businessFact: "how long?" },
    ]),
  ];
  // A0 finds the resembling rules and misses the non-resembling one; A2's screen finds it.
  const a0 = [out({ ruleId: "EN-03", verdict: "gap" }), out({ ruleId: "DR-01", verdict: "gap" })];
  const a2 = [
    out({ ruleId: "EN-03", verdict: "gap" }),
    out(
      { ruleId: "DR-01", verdict: "needs-ba-input" },
      { ruleId: "AL-02", verdict: "needs-ba-input" },
    ),
  ];
  const run = (outputs: GoverningArmOutput[]) =>
    items.map((it, i) => scoreItem(corpus, it, outputs[i]!));

  it("gives the arms different subset recall, and a subset number unlike the overall one", () => {
    const s0 = summarizeRuns([run(a0), run(a0)]);
    const s2 = summarizeRuns([run(a2), run(a2)]);
    expect(s0.metrics.nonResemblingRecall.mean).toBe(0);
    expect(s2.metrics.nonResemblingRecall.mean).toBe(1);
    expect(s0.metrics.recall.mean).toBeCloseTo(2 / 3, 10);
    expect(s2.metrics.recall.mean).toBe(1);
    // Folded into the overall number, A0's miss would read 2/3, not 0.
    expect(s0.metrics.nonResemblingRecall.mean).not.toBe(s0.metrics.recall.mean);
  });

  it("asks: the ask rate is needs-ba-input over rules applied", () => {
    expect(aggregate(run(a2)).askRate).toBeCloseTo(2 / 3, 10);
    expect(aggregate(run(a0)).askRate).toBe(0);
  });
});

describe("scoreItem and aggregate", () => {
  it("counts a hallucinated rule id against precision, and a rule judged twice once", () => {
    const s = scoreItem(
      corpus,
      item("R", [{ ruleId: "EN-03", verdict: "gap" }]),
      out(
        { ruleId: "EN-03", verdict: "gap" },
        { ruleId: "EN-03", verdict: "compliant" },
        { ruleId: "ZZ-99", verdict: "gap" },
      ),
    );
    expect(s.applied).toBe(2);
    expect(s.hardErrors).toBe(0); // the first judgement of EN-03 is the one scored
    const m = aggregate([s]);
    expect(m.precision).toBe(0.5);
    expect(m.recall).toBe(1);
    expect(m.verdictAccuracy).toBe(1);
  });

  it("counts a missed pair as a recall miss and a wrong verdict", () => {
    const s = scoreItem(corpus, item("R", [{ ruleId: "EN-03", verdict: "gap" }]), out());
    expect(s.pairs).toEqual([
      expect.objectContaining({ ruleId: "EN-03", truth: "gap", verdict: null }),
    ]);
    const m = aggregate([s]);
    expect(m.recall).toBe(0);
    expect(m.verdictAccuracy).toBe(0);
    expect(m.precision).toBeNull();
  });

  it("counts a negative item clean only when nothing is applied", () => {
    const clean = scoreItem(corpus, item("N1", []), out());
    const noisy = scoreItem(corpus, item("N2", []), out({ ruleId: "EN-03", verdict: "gap" }));
    const m = aggregate([clean, noisy]);
    expect(m.negatives).toBe(2);
    expect(m.cleanNegatives).toBe(1);
    expect(m.recall).toBeNull();
    expect(m.precision).toBe(0);
  });
});

describe("bootstrapRatioCi", () => {
  it("is seeded, brackets the pooled ratio, and is degenerate when every item agrees", () => {
    const nums = [1, 0, 1, 1, 0, 1, 1, 1];
    const dens = [1, 1, 1, 1, 1, 1, 1, 1];
    const a = bootstrapRatioCi(nums, dens, { iterations: 2000 });
    expect(a).toEqual(bootstrapRatioCi(nums, dens, { iterations: 2000 }));
    expect(a![0]).toBeLessThanOrEqual(0.75);
    expect(a![1]).toBeGreaterThanOrEqual(0.75);
    expect(a![1]).toBeGreaterThan(a![0]);
    expect(bootstrapRatioCi([2, 2], [2, 2])).toEqual([1, 1]);
  });

  it("is null with no denominator, and refuses unpaired counts", () => {
    expect(bootstrapRatioCi([0, 0], [0, 0])).toBeNull();
    expect(bootstrapRatioCi([], [])).toBeNull();
    expect(() => bootstrapRatioCi([1], [1, 2])).toThrow(/paired counts/);
  });
});

describe("checkThresholds", () => {
  const bars = {
    overallRecall: 0.9,
    nonResemblingRecall: 0.85,
    precision: 0.6,
    citationAccuracy: 0.95,
    maxNoEvidenceCompliantErrors: 0,
  };

  it("passes a perfect arm and fails a hard error, a low metric and an undefined one", () => {
    const perfect = summarizeRuns([
      [
        scoreItem(
          corpus,
          item("R", [{ ruleId: "AL-02", verdict: "gap", nonResembling: true }]),
          out({ ruleId: "AL-02", verdict: "gap", citation: VERBATIM }),
        ),
      ],
    ]);
    expect(checkThresholds(perfect, bars).every((c) => c.pass)).toBe(true);

    const bad = summarizeRuns([
      [
        scoreItem(
          corpus,
          item("R", [
            { ruleId: "AL-02", verdict: "needs-ba-input", businessFact: "x" },
            { ruleId: "EN-03", verdict: "gap" },
          ]),
          out({ ruleId: "AL-02", verdict: "compliant" }),
        ),
      ],
    ]);
    const byBar = Object.fromEntries(checkThresholds(bad, bars).map((c) => [c.bar, c]));
    expect(byBar.overallRecall).toMatchObject({ pass: false, measured: "0.50" });
    expect(byBar.nonResemblingRecall).toMatchObject({ pass: false, measured: "n/a" });
    expect(byBar.citationAccuracy).toMatchObject({ pass: false, measured: "n/a" });
    expect(byBar.maxNoEvidenceCompliantErrors).toMatchObject({
      pass: false,
      measured: "1 (worst run)",
    });
  });

  it("summarizeRuns averages each metric over the runs it is defined in", () => {
    const r1 = [scoreItem(corpus, item("R", [{ ruleId: "EN-03", verdict: "gap" }]), out())];
    const r2 = [
      scoreItem(
        corpus,
        item("R", [{ ruleId: "EN-03", verdict: "gap" }]),
        out({ ruleId: "EN-03", verdict: "gap" }),
      ),
    ];
    const s = summarizeRuns([r1, r2]);
    expect(s.metrics.recall.perRun).toEqual([0, 1]);
    expect(s.metrics.recall.mean).toBe(0.5);
    expect(s.metrics.precision.perRun).toEqual([null, 1]);
    expect(s.metrics.precision.mean).toBe(1);
    expect(s.runs).toBe(2);
    expect(summarizeRuns([]).metrics.recall.mean).toBeNull();
  });
});
