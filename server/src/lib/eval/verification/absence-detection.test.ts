/**
 * Epic #1107 (#1111 / A3) — the absence-claim DETECTION rate, measured.
 *
 * This test is the measurement #1111 asks for, wired so it cannot rot: the
 * numbers are printed on every run and the floors fail the build if detection
 * regresses. The misses are ASSERTED BY NAME rather than merely allowed, so a
 * change that trades one miss for another shows up as a diff instead of hiding
 * behind an unchanged aggregate.
 */
import { describe, expect, it } from "vitest";
import { assertsAbsence } from "../../analysis/requirement-verdict.js";
import {
  ABSENCE_DETECTION_CASES,
  formatAbsenceDetectionReport,
  scoreAbsenceDetection,
  tierDetector,
} from "./absence-detection.js";

describe("absence-claim detection rate (#1111)", () => {
  const score = scoreAbsenceDetection();
  const gateScore = scoreAbsenceDetection(tierDetector("gate"));

  it("prints the measured rate for BOTH tiers, misses first", () => {
    const report = `${formatAbsenceDetectionReport(score)}\n\n${formatAbsenceDetectionReport(
      gateScore,
      "gate tier (#773 — what downgrades a finding)",
    )}`;
    // eslint-disable-next-line no-console -- the measurement is the deliverable.
    console.log(`\n${report}\n`);
    expect(report).toContain("ABSENCE-CLAIM DETECTION");
    expect(report).toContain("KNOWN MISSES");
  });

  it("catches every absence claim a lexical detector can reach", () => {
    // A floor, not a target. The pre-#1111 pattern list scored 5/15 (recall
    // 0.3333) on this same set; the #1111 widening takes it to 12/15, and the
    // remaining three are the documented lexical bound below.
    expect(score.absenceCases).toBe(15);
    expect(score.truePositives).toBeGreaterThanOrEqual(12);
    expect(score.recall).toBeGreaterThanOrEqual(0.8);
  });

  it("keeps the DESTRUCTIVE gate tier narrower than the read-only grader", () => {
    // The gate rewrites a finding's title and drops it to `info`, so it declines
    // the subordinate-clause patterns the grader takes. It pays for that in
    // recall, and the number is stated rather than assumed.
    expect(gateScore.recall).toBeLessThan(score.recall);
    expect(gateScore.falsePositives).toBeLessThanOrEqual(score.falsePositives);
  });

  it("makes `grader` a strict SUPERSET of `gate` — the tiers cannot disagree", () => {
    // If they could disagree in the other direction, a finding could be
    // downgraded by #773 and skipped by #1111's verifier — flagged, unchecked
    // and unexplained.
    for (const c of ABSENCE_DETECTION_CASES) {
      if (tierDetector("gate")(c)) expect(tierDetector("grader")(c)).toBe(true);
    }
  });

  it("names every miss, so no absence claim is silently unverified", () => {
    // #1111: "known misses listed rather than hidden". All three assert an
    // absence with NO negation vocabulary ("only 3 of 5", "remains open",
    // "stops at"), which no pattern list can reach — the alternative is an LLM
    // classifier on every finding, which the epic's cheap-signal-first rule
    // rejects. If this list changes, the diff says which shape moved.
    expect(score.misses.map((m) => m.id)).toEqual(["AD-26", "AD-27", "AD-28"]);
  });

  it("names every over-match, and keeps them cheap", () => {
    // AD-28 is corpus VC-12: a POSITIVE claim with an absence-flavoured
    // subordinate clause. The generous #773 patterns match it, and the cost is
    // one extra provider call plus (at worst) a cap at `medium`, which carries
    // the neutral rank. Precision is deliberately traded for recall here.
    expect(score.overMatches.map((o) => o.id)).toEqual(["AD-25"]);
    expect(score.precision).toBeGreaterThanOrEqual(0.9);
  });

  it("scores the SAME classifier production uses, not a private copy", () => {
    for (const c of ABSENCE_DETECTION_CASES) {
      const viaProduction = assertsAbsence({ title: c.title, body: c.body }, "grader");
      const viaHarness = !score.misses.includes(c) && (c.absence || score.overMatches.includes(c));
      expect(viaHarness).toBe(viaProduction);
    }
  });

  it("is a balanced set, so recall and precision are both meaningful", () => {
    expect(score.total).toBe(ABSENCE_DETECTION_CASES.length);
    expect(score.absenceCases).toBeGreaterThan(score.total / 3);
    expect(score.total - score.absenceCases).toBeGreaterThan(score.total / 3);
  });

  it("every case carries a visible rationale for its label", () => {
    for (const c of ABSENCE_DETECTION_CASES) {
      expect(c.why.length).toBeGreaterThan(20);
    }
  });
});

describe("scoreAbsenceDetection (pure)", () => {
  const CASES = [
    { id: "A", title: "x", body: "y", absence: true, why: "labelled absence for this unit test" },
    { id: "B", title: "x", body: "y", absence: false, why: "labelled positive for this unit test" },
  ];

  it("reports a perfect detector as recall 1 / precision 1", () => {
    const s = scoreAbsenceDetection((c) => c.absence, CASES);
    expect(s).toMatchObject({ recall: 1, precision: 1, misses: [], overMatches: [] });
  });

  it("reports a detector that flags nothing as recall 0 — never as precision 1", () => {
    const s = scoreAbsenceDetection(() => false, CASES);
    // Vacuous precision is the #1016 defect: a detector that abstains on
    // everything must not read as perfectly precise.
    expect(s.recall).toBe(0);
    expect(s.precision).toBe(0);
    expect(s.misses.map((m) => m.id)).toEqual(["A"]);
  });

  it("reports a detector that flags everything as recall 1 with an over-match", () => {
    const s = scoreAbsenceDetection(() => true, CASES);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(0.5);
    expect(s.overMatches.map((o) => o.id)).toEqual(["B"]);
  });

  it("says 'none' when there is nothing to hide", () => {
    const report = formatAbsenceDetectionReport(scoreAbsenceDetection((c) => c.absence, CASES));
    expect(report).toContain("KNOWN MISSES     none");
    expect(report).not.toContain("OVER-MATCHES");
  });

  it("handles an empty set without dividing by zero", () => {
    const s = scoreAbsenceDetection(() => true, []);
    expect(s).toMatchObject({ total: 0, recall: 0, precision: 0 });
  });
});
