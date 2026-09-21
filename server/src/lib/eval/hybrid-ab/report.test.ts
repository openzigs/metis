/**
 * #335 — unit tests for the A/B report renderer (pure string builder).
 */
import { describe, expect, it } from "vitest";
import { renderAbReport } from "./report.js";
import { runAbEval } from "./runner.js";
import { DEFAULT_AB_CORPUS } from "./corpus.js";
import type { AbCorpusItem, SectionEvaluator } from "./types.js";

const CORPUS: AbCorpusItem[] = [
  {
    id: "doc1",
    title: "Doc One",
    sections: [
      { id: "s-lit", label: "Business Rules", tier: "literal" },
      { id: "s-nar", label: "Overview", tier: "narrative" },
    ],
  },
];

const evaluate: SectionEvaluator = ({ arm }) =>
  arm === "all-sonnet"
    ? { faithfulness: 0.9, escalated: false, localTokens: 0, cloudTokens: 1000 }
    : { faithfulness: 0.88, escalated: false, localTokens: 1000, cloudTokens: 0 };

describe("renderAbReport", () => {
  it("renders both arms, deltas, gate criteria, and the verdict", async () => {
    const result = await runAbEval({ corpus: CORPUS, evaluate });
    const report = renderAbReport(result);

    expect(report).toContain("all-Sonnet (baseline)");
    expect(report).toContain("local+escalation (candidate)");
    expect(report).toContain("Deltas (candidate");
    expect(report).toContain("Gate criteria:");
    // every criterion prints a PASS/FAIL marker
    expect(report).toContain("Overall faithfulness within epsilon of baseline");
    expect(report).toContain("VERDICT:");
  });

  it("labels the verdict PASS when the gate passes", async () => {
    const result = await runAbEval({ corpus: CORPUS, evaluate });
    expect(result.verdict.passed).toBe(true);
    expect(renderAbReport(result)).toContain("PASS — rollout gate met");
  });

  it("labels the verdict FAIL when the gate fails", async () => {
    const bad: SectionEvaluator = ({ arm }) =>
      arm === "all-sonnet"
        ? { faithfulness: 0.95, escalated: false, localTokens: 0, cloudTokens: 1000 }
        : { faithfulness: 0.2, escalated: false, localTokens: 1000, cloudTokens: 0 };
    const result = await runAbEval({ corpus: CORPUS, evaluate: bad });
    expect(result.verdict.passed).toBe(false);
    expect(renderAbReport(result)).toContain("FAIL — do NOT flip defaults");
  });

  it("renders n/a for tiers with no verified sections", async () => {
    const result = await runAbEval({ corpus: CORPUS, evaluate });
    // reconstruction tier has no sections in this corpus
    const report = renderAbReport(result);
    expect(report).toContain("reconstruction");
    expect(report).toContain("n/a");
  });

  it("renders the default checked-in corpus shape", async () => {
    const result = await runAbEval({ corpus: DEFAULT_AB_CORPUS, evaluate });
    const report = renderAbReport(result);
    expect(report).toContain(`sections=${result.sectionCount}`);
    expect(result.sectionCount).toBeGreaterThan(0);
  });
});
