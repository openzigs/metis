import { describe, it, expect } from "vitest";
import {
  AMBIGUITY_WEIGHT,
  DEFAULT_ESCALATION_POLICY,
  IMPACT_WEIGHT,
  decideEscalations,
  scoreAmbiguity,
  scoreImpact,
  scoreRequirementEscalation,
  splitEscalationBudget,
  type EscalationPolicyConfig,
  type RequirementEscalationInput,
} from "./escalation-policy.js";

// A short, marker-dense requirement is maximally ambiguous; a long, specific one
// is minimally ambiguous. These anchor the low/high axis for the matrix below.
const HIGH_AMBIGUITY_TEXT = "Handle everything appropriately";
const LOW_AMBIGUITY_TEXT =
  "The primary login submit button background shall use the hex value 1a73e8";

describe("scoreAmbiguity", () => {
  it("scores a marker-dense one-liner at the maximum", () => {
    expect(scoreAmbiguity(HIGH_AMBIGUITY_TEXT)).toBe(1);
  });

  it("scores a long, specific requirement at zero", () => {
    expect(scoreAmbiguity(LOW_AMBIGUITY_TEXT)).toBe(0);
  });

  it("does not false-match markers inside other words (every ⊄ everything, all ⊄ install)", () => {
    // "install" contains "all" and "everything" contains "every" — word-boundary
    // matching must NOT count those. This text has exactly one real marker: "all".
    const score = scoreAmbiguity("Install the connector for all repositories in the workspace");
    // 9 words ⇒ brevity 0; one marker ("all") ⇒ markerComponent 1/3.
    expect(score).toBeCloseTo(0.75 * (1 / 3), 5);
  });

  it("gives a moderately vague long requirement a mid score below threshold", () => {
    // "handle" + "reasonably" = 2 markers, 9 words ⇒ brevity 0.
    const score = scoreAmbiguity("The system should handle errors reasonably and stay stable");
    expect(score).toBeCloseTo(0.75 * (2 / 3), 5);
    expect(score).toBeLessThan(1);
  });

  it("scores empty / whitespace text at zero", () => {
    expect(scoreAmbiguity("")).toBe(0);
    expect(scoreAmbiguity("   \n ")).toBe(0);
  });
});

describe("scoreImpact", () => {
  it("is zero for no impacted symbols", () => {
    expect(scoreImpact(0)).toBe(0);
  });

  it("scales linearly up to the saturation point, then clamps to 1", () => {
    expect(scoreImpact(4, 8)).toBe(0.5);
    expect(scoreImpact(8, 8)).toBe(1);
    expect(scoreImpact(20, 8)).toBe(1);
  });

  it("treats negative / non-finite sizes as zero", () => {
    expect(scoreImpact(-3)).toBe(0);
    expect(scoreImpact(Number.NaN)).toBe(0);
  });

  it("falls back to the default saturation when given a non-positive saturation", () => {
    // saturation 0 ⇒ use DEFAULT_IMPACT_SATURATION (8): 5/8 = 0.625.
    expect(scoreImpact(5, 0)).toBe(0.625);
  });

  it("uses the default saturation when no saturation arg is supplied", () => {
    expect(scoreImpact(8)).toBe(1);
  });
});

describe("scoreRequirementEscalation — low/high ambiguity × low/high impact", () => {
  const cfg = DEFAULT_ESCALATION_POLICY;
  const score = (text: string, blastRadiusSize: number) =>
    scoreRequirementEscalation({ id: "R", text, blastRadiusSize }, cfg).score;

  it("weights are an even split summing to 1", () => {
    expect(AMBIGUITY_WEIGHT + IMPACT_WEIGHT).toBe(1);
  });

  it("low ambiguity + low impact ⇒ well below threshold (standard)", () => {
    expect(score(LOW_AMBIGUITY_TEXT, 0)).toBe(0);
  });

  it("low ambiguity + high impact ⇒ meets threshold (deep)", () => {
    // 0.5*0 + 0.5*1.0 = 0.5
    expect(score(LOW_AMBIGUITY_TEXT, 8)).toBe(0.5);
  });

  it("high ambiguity + low impact ⇒ meets threshold (deep)", () => {
    // 0.5*1.0 + 0.5*0 = 0.5
    expect(score(HIGH_AMBIGUITY_TEXT, 0)).toBe(0.5);
  });

  it("high ambiguity + high impact ⇒ maximal", () => {
    expect(score(HIGH_AMBIGUITY_TEXT, 8)).toBe(1);
  });

  it("returns the sub-scores alongside the combined score", () => {
    const s = scoreRequirementEscalation({
      id: "R",
      text: HIGH_AMBIGUITY_TEXT,
      blastRadiusSize: 8,
    });
    expect(s).toEqual({ ambiguityScore: 1, impactScore: 1, score: 1 });
  });
});

describe("decideEscalations", () => {
  const inputs = (): RequirementEscalationInput[] => [
    { id: "R1", text: HIGH_AMBIGUITY_TEXT, blastRadiusSize: 8 }, // score 1.0 → deep
    { id: "R2", text: LOW_AMBIGUITY_TEXT, blastRadiusSize: 8 }, // score 0.5 → eligible
    { id: "R3", text: LOW_AMBIGUITY_TEXT, blastRadiusSize: 0 }, // score 0.0 → standard
  ];

  it("routes only score >= threshold requirements to deep, rest to standard", () => {
    const out = decideEscalations(inputs(), DEFAULT_ESCALATION_POLICY);
    const byId = Object.fromEntries(out.map((d) => [d.requirementId, d]));
    expect(byId.R1.depth).toBe("deep");
    expect(byId.R2.depth).toBe("deep");
    expect(byId.R3.depth).toBe("standard");
    expect(byId.R3.score).toBe(0);
  });

  it("caps the number of escalations, keeping the highest scorers", () => {
    const cfg: EscalationPolicyConfig = { ...DEFAULT_ESCALATION_POLICY, maxEscalations: 1 };
    const out = decideEscalations(inputs(), cfg);
    const deep = out.filter((d) => d.depth === "deep");
    // Only the single highest scorer (R1 @ 1.0) is deep; R2 (0.5) is demoted.
    expect(deep.map((d) => d.requirementId)).toEqual(["R1"]);
    expect(out.find((d) => d.requirementId === "R2")?.depth).toBe("standard");
  });

  it("escalates nothing when maxEscalations is 0", () => {
    const cfg: EscalationPolicyConfig = { ...DEFAULT_ESCALATION_POLICY, maxEscalations: 0 };
    expect(decideEscalations(inputs(), cfg).every((d) => d.depth === "standard")).toBe(true);
  });

  it("sorts deep-first, then by score desc, then id asc (deterministic)", () => {
    const out = decideEscalations(inputs(), DEFAULT_ESCALATION_POLICY);
    expect(out.map((d) => d.requirementId)).toEqual(["R1", "R2", "R3"]);
  });

  it("truncates the persisted text and preserves the blast-radius size", () => {
    const long = "x".repeat(400);
    const [d] = decideEscalations([{ id: "R", text: long, blastRadiusSize: 5 }], {
      ...DEFAULT_ESCALATION_POLICY,
      maxEscalations: 5,
    });
    expect(d.text.length).toBeLessThanOrEqual(280);
    expect(d.blastRadiusSize).toBe(5);
  });

  it("normalizes a fractional / negative blast-radius size to a non-negative int", () => {
    const out = decideEscalations(
      [
        { id: "A", text: "x", blastRadiusSize: 2.9 },
        { id: "B", text: "y", blastRadiusSize: -4 },
      ],
      DEFAULT_ESCALATION_POLICY,
    );
    const byId = Object.fromEntries(out.map((d) => [d.requirementId, d]));
    expect(byId.A.blastRadiusSize).toBe(2);
    expect(byId.B.blastRadiusSize).toBe(0);
  });

  it("uses the default policy when no config is supplied", () => {
    const out = decideEscalations([{ id: "R1", text: HIGH_AMBIGUITY_TEXT, blastRadiusSize: 8 }]);
    expect(out[0].depth).toBe("deep");
  });
});

describe("splitEscalationBudget — reallocates without growing the budget", () => {
  it("splits proportionally and sums EXACTLY to the input budget", () => {
    const { deepBudget, standardBudget } = splitEscalationBudget(100_000, 2, 3);
    expect(deepBudget).toBe(40_000);
    expect(standardBudget).toBe(60_000);
    expect(deepBudget + standardBudget).toBe(100_000);
  });

  it("gives the whole budget to the standard pass when nothing escalated", () => {
    expect(splitEscalationBudget(100_000, 0, 5)).toEqual({
      deepBudget: 0,
      standardBudget: 100_000,
    });
  });

  it("gives the whole budget to the deep pass when everything escalated", () => {
    expect(splitEscalationBudget(100_000, 5, 0)).toEqual({
      deepBudget: 100_000,
      standardBudget: 0,
    });
  });

  it("clamps a negative / fractional budget to a non-negative integer", () => {
    expect(splitEscalationBudget(-500, 1, 1)).toEqual({ deepBudget: 0, standardBudget: 0 });
    // floor(100.9) = 100 → split 1:1 (deep floor(50)=50, standard 50).
    expect(splitEscalationBudget(100.9, 1, 1)).toEqual({ deepBudget: 50, standardBudget: 50 });
  });

  it("NEVER exceeds the input budget for any deep/standard split (budget accounting)", () => {
    const budget = 100_000;
    for (let deep = 0; deep <= 10; deep++) {
      for (let standard = 0; standard <= 10; standard++) {
        const { deepBudget, standardBudget } = splitEscalationBudget(budget, deep, standard);
        expect(deepBudget).toBeGreaterThanOrEqual(0);
        expect(standardBudget).toBeGreaterThanOrEqual(0);
        expect(deepBudget + standardBudget).toBeLessThanOrEqual(budget);
        // When both passes exist the split is exact (no budget lost or created).
        if (deep > 0 && standard > 0) {
          expect(deepBudget + standardBudget).toBe(budget);
        }
      }
    }
  });
});
