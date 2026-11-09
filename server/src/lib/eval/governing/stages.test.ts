/**
 * #2108 — the stage each error of a reading arose in, read from A5's records.
 */
import { describe, expect, it } from "vitest";
import { stageErrors, stageSection, type RuleStage } from "./stages.js";

const stage = (
  ruleId: string,
  applicability: RuleStage["applicability"],
  finding?: RuleStage["finding"],
): RuleStage => ({
  ruleId,
  foundBy: ["screen"],
  applicability,
  ...(finding ? { finding } : {}),
});

describe("stageErrors", () => {
  it("leaves out a pair the arm got right", () => {
    expect(
      stageErrors(
        [{ ruleId: "PA-05", truth: "compliant", verdict: "compliant" }],
        [stage("PA-05", "applies", "compliant")],
      ),
    ).toEqual([]);
  });

  it("names a miss: not a candidate, ruled out by the judge, or left without a finding", () => {
    const errors = stageErrors(
      [
        { ruleId: "PA-05", truth: "gap", verdict: null },
        { ruleId: "PA-08", truth: "needs-ba-input", verdict: null },
        { ruleId: "LG-01", truth: "compliant", verdict: null },
      ],
      [stage("PA-08", "does-not-apply"), stage("LG-01", "applies")],
    );
    expect(errors.map((e) => [e.ruleId, e.kind, e.stage])).toEqual([
      ["PA-05", "missed", "not-a-candidate"],
      ["PA-08", "missed", "judged-does-not-apply"],
      ["LG-01", "missed", "findings-call"],
    ]);
  });

  it("names an extra rule by the applicability verdict that brought it in", () => {
    const errors = stageErrors(
      [
        { ruleId: "LG-04", truth: null, verdict: "gap" },
        { ruleId: "LG-05", truth: null, verdict: "needs-ba-input" },
      ],
      [stage("LG-04", "applies", "gap"), stage("LG-05", "uncertain", "needs-ba-input")],
    );
    expect(errors.map((e) => [e.ruleId, e.kind, e.stage])).toEqual([
      ["LG-04", "extra", "applicability-applies"],
      ["LG-05", "extra", "applicability-uncertain"],
    ]);
  });

  it("puts a wrong verdict on the findings call, unless applicability left the rule uncertain", () => {
    const errors = stageErrors(
      [
        { ruleId: "DP-01", truth: "compliant", verdict: "gap" },
        { ruleId: "PA-14", truth: "gap", verdict: "needs-ba-input" },
      ],
      [stage("DP-01", "applies", "gap"), stage("PA-14", "uncertain", "needs-ba-input")],
    );
    expect(errors).toEqual([
      {
        ruleId: "DP-01",
        kind: "wrong-verdict",
        stage: "findings-call",
        truth: "compliant",
        verdict: "gap",
      },
      {
        ruleId: "PA-14",
        kind: "wrong-verdict",
        stage: "applicability-uncertain",
        truth: "gap",
        verdict: "needs-ba-input",
      },
    ]);
  });
});

describe("stageSection", () => {
  it("prints nothing when no arm records stages", () => {
    expect(
      stageSection({
        arms: [{ id: "A4", completedRuns: 1, records: [{ itemId: "OS-01", run: 1, pairs: [] }] }],
      }),
    ).toEqual([]);
  });

  it("counts errors by kind and stage over the scored runs, and lists each pair with its runs", () => {
    const miss = { ruleId: "PA-05", truth: "gap" as const, verdict: null };
    const lines = stageSection({
      arms: [
        {
          id: "A5",
          completedRuns: 2,
          records: [
            { itemId: "OS-08", run: 1, pairs: [miss], stages: [] },
            { itemId: "OS-08", run: 2, pairs: [miss], stages: [] },
            // A run the cap cut short is not scored, so it is not counted either.
            { itemId: "OS-08", run: 3, pairs: [miss], stages: [] },
            {
              itemId: "OS-13",
              run: 1,
              pairs: [{ ruleId: "LG-04", truth: null, verdict: "gap" }],
              stages: [stage("LG-04", "applies", "gap")],
            },
          ],
        },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("## Where each error arose (#2108)");
    expect(text).toContain("| missed | 2 | 0 | 0 | 0 | 0 |");
    expect(text).toContain("| extra | 0 | 0 | 1 | 0 | 0 |");
    expect(text).toContain("| wrong-verdict | 0 | 0 | 0 | 0 | 0 |");
    expect(text).toContain(
      "- OS-08 → PA-05: missed, not-a-candidate (label gap, said none): 2 of 2 run(s)",
    );
    expect(text).toContain(
      "- OS-13 → LG-04: extra, applicability-applies (label none, said gap): 1 of 2 run(s)",
    );
  });

  it("says so when an arm that records stages made no error", () => {
    const lines = stageSection({
      arms: [
        {
          id: "A5",
          completedRuns: 1,
          records: [
            {
              itemId: "OS-08",
              run: 1,
              pairs: [{ ruleId: "PA-05", truth: "compliant", verdict: "compliant" }],
              stages: [stage("PA-05", "applies", "compliant")],
            },
          ],
        },
      ],
    });
    expect(lines).toContain("No error in any scored run.");
  });
});
