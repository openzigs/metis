import { describe, expect, it } from "vitest";
import {
  DETERMINISTIC_ARM_THRESHOLDS,
  buildReport,
  checkThresholds,
  compareArms,
  gateArm,
  parseCaseId,
  parseRunCount,
  renderCaseDetail,
  runArm,
  runArmRepeated,
  summarizeArmRuns,
  thresholdsForArm,
  toJsonReport,
  toMarkdownReport,
  type ArmRunResult,
} from "./runner.js";
import { deterministicArm, type VerifierArm } from "./arms.js";
import {
  DEFAULT_VERIFICATION_CORPUS,
  loadVerificationCorpus,
  resolveVerificationCorpusDir,
  type VerificationCase,
  type VerificationCorpus,
} from "./corpus.js";
import { aggregateCaseScores, scoreCase } from "./scorer.js";

function aCase(id: string, supported: boolean): VerificationCase {
  return {
    id,
    hardCase: "semantic-mismatch",
    title: `case ${id}`,
    provenance: { origin: "real", source: "s", groundTruth: "g" },
    finding: { title: "t", body: "b" },
    groundedCitations: [],
    droppedCitations: [],
    absenceConfirmable: true,
    evidence: [{ filePath: "a.ts", startLine: 1, endLine: 2, excerpt: "code" }],
    expected: { supported, rationale: "rationale" },
  };
}

function tinyCorpus(): VerificationCorpus {
  return {
    id: "tiny",
    description: "d",
    warning: "hard-case enriched",
    provenanceNote: "p",
    cases: [aCase("A", false), aCase("B", true)],
  };
}

/** A scriptable arm: verdict per case id, with a fixed per-call token cost. */
function scriptedArm(
  id: "deterministic" | "panel",
  verdicts: Record<string, "confirmed" | "unverified" | "could-not-verify" | null>,
  tokensPerCall = 0,
): VerifierArm {
  return {
    id,
    label: `scripted ${id}`,
    usesLlm: tokensPerCall > 0,
    verify: async (c) => ({
      status: verdicts[c.id] ?? null,
      usage:
        tokensPerCall > 0
          ? { promptTokens: tokensPerCall, completionTokens: 10, llmCalls: 3 }
          : undefined,
    }),
  };
}

describe("runArm", () => {
  it("scores every case and reports zero cost for a free arm", async () => {
    const result = await runArm(
      tinyCorpus(),
      scriptedArm("deterministic", { A: "unverified", B: "confirmed" }),
    );
    expect(result.scores.map((s) => s.outcome)).toEqual(["TP", "TN"]);
    expect(result.cost).toMatchObject({
      totalTokens: 0,
      llmCalls: 0,
      promptTokens: 0,
      tokensPerFinding: 0,
    });
  });

  it("accumulates token cost and derives tokens per finding", async () => {
    const result = await runArm(tinyCorpus(), scriptedArm("panel", { A: null, B: null }, 100));
    expect(result.cost.promptTokens).toBe(200);
    expect(result.cost.completionTokens).toBe(20);
    expect(result.cost.totalTokens).toBe(220);
    expect(result.cost.llmCalls).toBe(6);
    expect(result.cost.tokensPerFinding).toBe(110);
  });

  it("measures wall clock from an injected clock", async () => {
    let t = 1000;
    const result = await runArm(tinyCorpus(), scriptedArm("deterministic", {}), () => (t += 25));
    expect(result.cost.wallClockMs).toBeGreaterThan(0);
  });

  it("reports a per-hard-case breakdown", async () => {
    const result = await runArm(
      tinyCorpus(),
      scriptedArm("deterministic", { A: "unverified", B: "confirmed" }),
    );
    expect(result.byHardCase["semantic-mismatch"].caseCount).toBe(2);
  });

  it("tolerates an arm that reports partial usage", async () => {
    // #1114 degradation: an arm whose provider returned no usage block must not
    // make the cost report NaN.
    const partial: VerifierArm = {
      id: "panel",
      label: "partial",
      usesLlm: true,
      verify: async () => ({
        status: null,
        usage: { promptTokens: 7 } as never,
      }),
    };
    const result = await runArm(tinyCorpus(), partial);
    expect(result.cost.totalTokens).toBe(14);
    expect(result.cost.completionTokens).toBe(0);
    expect(result.cost.llmCalls).toBe(0);
  });

  it("handles a corpus with no cases without dividing by zero", async () => {
    const empty: VerificationCorpus = { ...tinyCorpus(), cases: [] };
    const result = await runArm(empty, scriptedArm("deterministic", {}));
    expect(result.cost.tokensPerFinding).toBe(0);
  });
});

describe("summarizeArmRuns", () => {
  function fakeRun(recall: number, precision: number, tokens: number): ArmRunResult {
    const scores = [scoreCase(aCase("A", false), recall >= 1 ? "unverified" : "confirmed")];
    return {
      armId: "panel",
      armLabel: "l",
      usesLlm: true,
      scores,
      aggregate: { ...aggregateCaseScores(scores), recall, precision },
      byHardCase: {},
      cost: {
        promptTokens: tokens,
        completionTokens: 0,
        totalTokens: tokens,
        llmCalls: 1,
        wallClockMs: 10,
        tokensPerFinding: tokens,
      },
    };
  }

  it("gates on the MEAN across runs and reports the spread", () => {
    const summary = summarizeArmRuns([fakeRun(1, 1, 100), fakeRun(0, 0, 200)]);
    expect(summary.meanAggregate.recall).toBe(0.5);
    expect(summary.meanCost.totalTokens).toBe(150);
    expect(summary.spreads.recall).toMatchObject({ min: 0, max: 1, mean: 0.5 });
    expect(summary.spreads.totalTokens.values).toEqual([100, 200]);
  });

  it("refuses to summarize zero runs", () => {
    expect(() => summarizeArmRuns([])).toThrow(/at least one run/);
  });
});

describe("runArmRepeated", () => {
  it("runs the arm N times", async () => {
    const summary = await runArmRepeated(tinyCorpus(), scriptedArm("panel", {}, 5), 3);
    expect(summary.runCount).toBe(3);
    expect(summary.runs).toHaveLength(3);
  });

  it("floors the run count at one", async () => {
    const summary = await runArmRepeated(tinyCorpus(), scriptedArm("deterministic", {}), 0);
    expect(summary.runCount).toBe(1);
  });
});

describe("parseRunCount", () => {
  it("defaults to 1 when every arm is deterministic", () => {
    expect(parseRunCount([], false)).toBe(1);
  });

  it("defaults to 3 when any arm makes live model calls", () => {
    expect(parseRunCount([], true)).toBe(3);
  });

  it("honours an explicit --runs", () => {
    expect(parseRunCount(["--runs", "5"], false)).toBe(5);
  });

  it("ignores a nonsensical --runs", () => {
    expect(parseRunCount(["--runs", "0"], false)).toBe(1);
    expect(parseRunCount(["--runs", "abc"], true)).toBe(3);
  });
});

describe("checkThresholds", () => {
  const agg = aggregateCaseScores([
    scoreCase(aCase("A", false), "unverified"),
    scoreCase(aCase("B", true), "confirmed"),
  ]);

  it("treats recall and precision as floors and over-flag as a ceiling", () => {
    const { passed, checks } = checkThresholds(agg, {
      recall: 0.5,
      precision: 0.5,
      maxOverFlagRate: 0.5,
    });
    expect(passed).toBe(true);
    expect(checks.map((c) => c.direction)).toEqual(["floor", "floor", "ceiling"]);
  });

  it("fails when recall drops below its floor", () => {
    const missed = aggregateCaseScores([scoreCase(aCase("A", false), "confirmed")]);
    const { passed, checks } = checkThresholds(missed, {
      recall: 0.5,
      precision: 0,
      maxOverFlagRate: 1,
    });
    expect(passed).toBe(false);
    expect(checks.find((c) => c.metric === "recall")?.passed).toBe(false);
  });

  it("fails when the over-flag rate exceeds its ceiling", () => {
    const overFlagged = aggregateCaseScores([scoreCase(aCase("B", true), "unverified")]);
    const { passed } = checkThresholds(overFlagged, {
      recall: 0,
      precision: 0,
      maxOverFlagRate: 0.5,
    });
    expect(passed).toBe(false);
  });
});

describe("thresholdsForArm", () => {
  it("returns the recorded floors for the baseline", () => {
    expect(thresholdsForArm("deterministic")).toBe(DETERMINISTIC_ARM_THRESHOLDS);
  });

  it("registers NO absolute floors for the panel — its bar is the comparison", () => {
    expect(thresholdsForArm("panel")).toBeNull();
  });
});

describe("compareArms", () => {
  async function summaryFor(
    arm: VerifierArm,
    verdicts: Record<string, "confirmed" | "unverified" | null>,
  ) {
    return runArmRepeated(
      tinyCorpus(),
      { ...arm, verify: scriptedArm(arm.id, verdicts).verify },
      1,
    );
  }

  it("passes a candidate that lifts recall without regressing it", async () => {
    const baseline = await summaryFor(deterministicArm(), { A: "confirmed", B: "confirmed" });
    const candidate = await summaryFor(scriptedArm("panel", {}), {
      A: "unverified",
      B: "confirmed",
    });
    const cmp = compareArms(baseline, candidate);
    expect(cmp.recallDelta).toBeGreaterThan(0);
    expect(cmp.beatsBaseline).toBe(true);
    expect(cmp.reasons.join(" ")).toContain("recall held or improved");
  });

  it("FAILS a candidate that regresses recall, however much precision it buys", async () => {
    const baseline = await summaryFor(deterministicArm(), { A: "unverified", B: "unverified" });
    const candidate = await summaryFor(scriptedArm("panel", {}), {
      A: "confirmed",
      B: "confirmed",
    });
    const cmp = compareArms(baseline, candidate);
    expect(cmp.recallDelta).toBeLessThan(0);
    expect(cmp.beatsBaseline).toBe(false);
    expect(cmp.reasons.join(" ")).toContain("RECALL REGRESSED");
  });

  it("FAILS a candidate that changes nothing but spends tokens", async () => {
    const baseline = await summaryFor(deterministicArm(), { A: "unverified", B: "confirmed" });
    const candidate = await summaryFor(scriptedArm("panel", {}), {
      A: "unverified",
      B: "confirmed",
    });
    const cmp = compareArms(baseline, candidate);
    expect(cmp.beatsBaseline).toBe(false);
    expect(cmp.reasons.join(" ")).toContain("paying tokens for nothing");
  });

  it("reports cost as its own line and never folds it into the verdict", async () => {
    const baseline = await summaryFor(deterministicArm(), { A: "confirmed", B: "confirmed" });
    const expensive = await runArmRepeated(
      tinyCorpus(),
      scriptedArm("panel", { A: "unverified", B: "confirmed" }, 5000),
      1,
    );
    const cmp = compareArms(baseline, expensive);
    // A ruinously expensive arm that improves quality still "beats" the baseline
    // on quality — the price is REPORTED so a human makes the trade.
    expect(cmp.beatsBaseline).toBe(true);
    expect(cmp.tokensPerFindingDelta).toBeGreaterThan(0);
    expect(cmp.reasons.join(" ")).toContain("REPORTED, not gated");
  });
});

describe("gateArm and buildReport", () => {
  it("passes an arm with no registered floors vacuously, and says so", async () => {
    const summary = await runArmRepeated(tinyCorpus(), scriptedArm("panel", {}, 10), 1);
    const gated = gateArm(summary);
    expect(gated.thresholds).toBeNull();
    expect(gated.checks).toEqual([]);
    expect(gated.passed).toBe(true);
  });

  it("omits the comparison when only the baseline ran", async () => {
    const baseline = await runArmRepeated(tinyCorpus(), scriptedArm("deterministic", {}), 1);
    expect(buildReport(tinyCorpus(), [baseline]).comparison).toBeNull();
  });

  it("builds the comparison when both arms ran", async () => {
    const baseline = await runArmRepeated(tinyCorpus(), scriptedArm("deterministic", {}), 1);
    const panel = await runArmRepeated(tinyCorpus(), scriptedArm("panel", {}, 10), 1);
    expect(buildReport(tinyCorpus(), [baseline, panel]).comparison).not.toBeNull();
  });

  it("fails the report when any arm breaks its floors", async () => {
    const corpus = tinyCorpus();
    // Miss the unsupported case AND over-flag the supported one.
    const summary = await runArmRepeated(
      corpus,
      scriptedArm("deterministic", { A: "confirmed", B: "unverified" }),
      1,
    );
    expect(buildReport(corpus, [summary]).passed).toBe(false);
  });
});

describe("reports", () => {
  async function report() {
    const corpus = tinyCorpus();
    const baseline = await runArmRepeated(
      corpus,
      scriptedArm("deterministic", { A: "unverified", B: "confirmed" }),
      1,
    );
    return buildReport(corpus, [baseline]);
  }

  it("keeps quality and cost as sibling keys in the JSON report", async () => {
    const json = toJsonReport(await report()) as Record<string, unknown>;
    const arms = json.arms as Array<Record<string, unknown>>;
    expect(arms[0]).toHaveProperty("quality");
    expect(arms[0]).toHaveProperty("cost");
    expect(json.corpusWarning).toContain("hard-case enriched");
  });

  it("reproduces the corpus caveat in the Markdown report", async () => {
    const md = toMarkdownReport(await report());
    expect(md).toContain("hard-case enriched");
    expect(md).toContain("Cost — reported beside quality, never folded into it");
    expect(md).toContain("No blended score is reported");
  });

  it("says plainly that the panel question is unanswered when it did not run", async () => {
    const md = toMarkdownReport(await report());
    expect(md).toContain("does not exist yet (#1109)");
  });

  it("renders the comparison section when both arms ran", async () => {
    const corpus = tinyCorpus();
    const baseline = await runArmRepeated(corpus, scriptedArm("deterministic", {}), 1);
    const panel = await runArmRepeated(
      corpus,
      scriptedArm("panel", { A: "unverified", B: "confirmed" }, 10),
      1,
    );
    const md = toMarkdownReport(buildReport(corpus, [baseline, panel]));
    expect(md).toContain("Is `panel` better than free?");
    expect(md).toContain("BEATS");
  });

  it("renders a losing comparison with signed deltas", async () => {
    const corpus = tinyCorpus();
    const baseline = await runArmRepeated(
      corpus,
      scriptedArm("deterministic", { A: "unverified", B: "confirmed" }),
      1,
    );
    // The panel misses the unsupported case AND over-flags the supported one.
    const panel = await runArmRepeated(
      corpus,
      scriptedArm("panel", { A: "confirmed", B: "unverified" }, 500),
      1,
    );
    const md = toMarkdownReport(buildReport(corpus, [baseline, panel]));
    expect(md).toContain("DOES NOT BEAT the deterministic baseline");
    expect(md).toContain("Recall -");
    expect(md).toContain("over-flag +");
  });

  it("renders threshold rows for an arm that has floors", async () => {
    const md = toMarkdownReport(await report());
    expect(md).toContain("### Thresholds");
    expect(md).toContain("`recall`");
  });

  it("says an arm without floors is judged by comparison, not an absolute", async () => {
    const corpus = tinyCorpus();
    const panel = await runArmRepeated(corpus, scriptedArm("panel", {}, 10), 1);
    const md = toMarkdownReport(buildReport(corpus, [panel]));
    expect(md).toContain("No registered floors for this arm");
  });
});

describe("renderCaseDetail", () => {
  it("prints the finding, both citation sets, the evidence and the ground truth", async () => {
    const corpus = tinyCorpus();
    const summary = await runArmRepeated(
      corpus,
      scriptedArm("deterministic", { A: "unverified" }),
      1,
    );
    const detail = renderCaseDetail(corpus, "A", [summary]);
    expect(detail).toContain("# A — case A");
    expect(detail).toContain("Evidence the agent was given");
    expect(detail).toContain("a.ts:1-2");
    expect(detail).toContain("supported: false");
    expect(detail).toContain("`deterministic` → unverified (TP)");
  });

  it("notes when a case is citation-free", async () => {
    const corpus = tinyCorpus();
    corpus.cases[0].evidence = [];
    corpus.cases[0].groundedCitations = [{ filePath: "x.ts", startLine: 1, endLine: 2 }];
    corpus.cases[0].droppedCitations = [{ filePath: "y.ts", reason: "file-not-retrieved" }];
    const summary = await runArmRepeated(corpus, scriptedArm("deterministic", {}), 1);
    const detail = renderCaseDetail(corpus, "A", [summary]);
    expect(detail).toContain("_(none — a citation-free claim)_");
    expect(detail).toContain("y.ts (file-not-retrieved)");
  });

  it("throws with the known ids on an unknown case", async () => {
    const corpus = tinyCorpus();
    const summary = await runArmRepeated(corpus, scriptedArm("deterministic", {}), 1);
    expect(() => renderCaseDetail(corpus, "NOPE", [summary])).toThrow(/unknown case/);
  });
});

describe("parseCaseId", () => {
  it("returns null when absent", () => {
    expect(parseCaseId([])).toBeNull();
    expect(parseCaseId(["--case", "--md"])).toBeNull();
  });

  it("reads --case <id>", () => {
    expect(parseCaseId(["--case", "VC-03"])).toBe("VC-03");
  });
});

describe("the recorded baseline on the committed corpus", () => {
  it("measures the numbers the PR and the thresholds quote", async () => {
    const corpus = await loadVerificationCorpus(
      resolveVerificationCorpusDir(DEFAULT_VERIFICATION_CORPUS),
    );
    const summary = await runArmRepeated(corpus, deterministicArm(), 1);
    const q = summary.meanAggregate;

    // The recorded 2026-07-28 baseline. If any of these move, the floors in
    // DETERMINISTIC_ARM_THRESHOLDS and the numbers in the PR body are stale.
    expect(q.caseCount).toBe(12);
    expect(q.truePositives).toBe(2);
    expect(q.falseNegatives).toBe(4);
    expect(q.falsePositives).toBe(2);
    expect(q.trueNegatives).toBe(4);
    expect(q.recall).toBeCloseTo(1 / 3, 6);
    expect(q.precision).toBeCloseTo(0.5, 6);
    expect(q.overFlagRate).toBeCloseTo(1 / 3, 6);

    // Free, by construction.
    expect(summary.meanCost.totalTokens).toBe(0);
    expect(summary.meanCost.llmCalls).toBe(0);

    // And it clears its own floors.
    expect(gateArm(summary).passed).toBe(true);
  });

  it("misses every case that requires READING the evidence", async () => {
    const corpus = await loadVerificationCorpus(
      resolveVerificationCorpusDir(DEFAULT_VERIFICATION_CORPUS),
    );
    const summary = await runArmRepeated(corpus, deterministicArm(), 1);
    const missed = summary.runs[0].scores.filter((s) => s.outcome === "FN").map((s) => s.id);
    // This is the load-bearing result for the #1109 decision: the free gate's
    // recall gap is exactly the semantic-support judgement it structurally
    // cannot make, which is what an LLM panel would be buying.
    expect(missed).toEqual(["VC-01", "VC-03", "VC-08", "VC-10"]);
  });
});
