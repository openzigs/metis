/**
 * Issue #1610 — the `partial` requirement verdict, derived deterministically from
 * per-acceptance-criterion evidence.
 *
 * Rules (first match wins):
 *   1. every criterion grounded-implemented             → implemented
 *   2. ≥1 grounded-implemented AND ≥1 gap-confirmed     → partial
 *   3. no criterion implemented AND ≥1 gap-confirmed    → gap-confirmed
 *   4. retrieval / budget starvation (could-not-verify) → could-not-verify
 *
 * Every per-criterion verdict below comes out of `gateFindingVerdict` rather than
 * being written by hand where the grounding matters, so `implemented` here means
 * what it means in production: a code citation survived the #734 gate.
 */
import { describe, expect, it } from "vitest";
import type { CodeCitation, FindingVerdict, RequirementVerdict } from "@metis/shared";
import {
  computeVerdictsForRequirements,
  gateFindingVerdict,
  rollUpCriterionVerdicts,
  type VerdictFindingInput,
  type VerdictRequirementInput,
} from "./requirement-verdict.js";

const grounded: CodeCitation = { filePath: "src/orders.ts", startLine: 10, endLine: 30 };

/** A code finding whose verdict went through the real gate. */
function gated(
  modelVerdict: FindingVerdict,
  opts: { cites?: CodeCitation[]; healthy?: boolean } = {},
): VerdictFindingInput {
  const healthy = opts.healthy ?? true;
  return {
    agentKey: "code",
    verdict: gateFindingVerdict({
      modelVerdict,
      groundedCitations: opts.cites ?? [],
      finding: { title: "t", body: "b" },
      absenceConfirmable: healthy,
      retrievalHealthy: healthy,
    }),
  };
}

const AC1 = "POST /orders rejects a quantity above stock with 409.";
const AC2 = "INVENTORY.QTY never goes below zero (CHECK constraint).";
const AC3 = "The stock check runs inside the order-writing transaction.";

/** One requirement citing findings 0..n-1, with criterion i → `perAc[i]`. */
function requirement(perAc: number[][], criteria = [AC1, AC2, AC3]): VerdictRequirementInput {
  const cited = [...new Set(perAc.flat())];
  return {
    evidenceFindingIndexes: cited,
    acceptanceCriteria: criteria.slice(0, perAc.length),
    criterionEvidence: perAc.map((ix, i) => ({
      criterion: criteria[i]!,
      evidenceFindingIndexes: ix,
    })),
  };
}

describe("#1610 — rollUpCriterionVerdicts (the rule table)", () => {
  const I = "implemented" as const;
  const G = "gap-confirmed" as const;
  const C = "could-not-verify" as const;

  it.each<[string, FindingVerdict[], RequirementVerdict]>([
    ["rule 1: every criterion implemented", [I, I], "implemented"],
    ["rule 1: a single implemented criterion", [I], "implemented"],
    ["rule 2: one implemented, one gap", [I, G], "partial"],
    ["rule 2: order does not matter", [G, I, I], "partial"],
    ["rule 2: an unverified criterion beside an implemented and a gap", [I, G, C], "partial"],
    ["rule 3: every criterion a gap", [G, G], "gap-confirmed"],
    ["rule 3: a gap beside an unverified criterion", [G, C], "gap-confirmed"],
    ["rule 4: implemented beside an unverified criterion is NOT implemented", [I, C], C],
    ["rule 4: nothing verified", [C, C], C],
    ["rule 4: no criterion at all", [], C],
  ])("%s", (_name, verdicts, expected) => {
    expect(rollUpCriterionVerdicts(verdicts)).toBe(expected);
  });
});

describe("#1610 — computeVerdictsForRequirements with per-criterion evidence", () => {
  it("2 ACs, one grounded-implemented and one gap-confirmed → partial", () => {
    const flat = [gated("implemented", { cites: [grounded] }), gated("gap-confirmed")];
    expect(computeVerdictsForRequirements([requirement([[0], [1]])], flat, true)).toEqual([
      "partial",
    ]);
  });

  it("2 ACs, one grounded and one unverifiable through budget starvation → could-not-verify, never partial or implemented", () => {
    // AC2 has no finding at all: the code agent never reached it.
    const flat = [gated("implemented", { cites: [grounded] })];
    const [verdict] = computeVerdictsForRequirements([requirement([[0], []])], flat, true);
    expect(verdict).toBe("could-not-verify");
    expect(verdict).not.toBe("partial");
    expect(verdict).not.toBe("implemented");
  });

  it("2 ACs, one grounded and one whose search was degraded → could-not-verify", () => {
    // The gap claim on AC2 comes from a run whose retrieval did not work, so the
    // gate downgrades it — it cannot make the requirement partial.
    const flat = [
      gated("implemented", { cites: [grounded] }),
      gated("gap-confirmed", { healthy: false }),
    ];
    expect(computeVerdictsForRequirements([requirement([[0], [1]])], flat, true)).toEqual([
      "could-not-verify",
    ]);
  });

  it("an UNGROUNDED 'implemented' claim can never make a requirement partial", () => {
    // The model says AC1 is implemented but its citation did not survive the
    // grounding gate (no grounded code citation reaches the gate).
    const flat = [gated("implemented", { cites: [] }), gated("gap-confirmed")];
    expect(flat[0]!.verdict).toBe("could-not-verify");
    const [verdict] = computeVerdictsForRequirements([requirement([[0], [1]])], flat, true);
    expect(verdict).not.toBe("partial");
    expect(verdict).toBe("gap-confirmed");
  });

  it("every AC grounded-implemented → implemented", () => {
    const flat = [
      gated("implemented", { cites: [grounded] }),
      gated("implemented", { cites: [grounded] }),
    ];
    expect(computeVerdictsForRequirements([requirement([[0], [1]])], flat, true)).toEqual([
      "implemented",
    ]);
  });

  it("no AC implemented and one gap → gap-confirmed", () => {
    const flat = [gated("gap-confirmed"), gated("could-not-verify")];
    expect(computeVerdictsForRequirements([requirement([[0], [1]])], flat, true)).toEqual([
      "gap-confirmed",
    ]);
  });

  it("a criterion's own findings decide it: a gap on AC1 beats an implementation on AC1", () => {
    const flat = [gated("implemented", { cites: [grounded] }), gated("gap-confirmed")];
    // Both findings bear on AC1 → AC1 is a gap (the three-state precedence);
    // AC2 is implemented by finding 0 → partial.
    expect(computeVerdictsForRequirements([requirement([[0, 1], [0]])], flat, true)).toEqual([
      "partial",
    ]);
  });

  it("a linked code finding no criterion claims still counts: its gap stops 'implemented'", () => {
    const flat = [
      gated("implemented", { cites: [grounded] }),
      gated("implemented", { cites: [grounded] }),
      gated("gap-confirmed"),
    ];
    const req = { ...requirement([[0], [1]]), evidenceFindingIndexes: [0, 1, 2] };
    expect(computeVerdictsForRequirements([req], flat, true)).toEqual(["partial"]);
  });

  it("an unclaimed NON-code finding does not join the roll-up", () => {
    const flat: VerdictFindingInput[] = [
      gated("implemented", { cites: [grounded] }),
      gated("implemented", { cites: [grounded] }),
      { agentKey: "document", verdict: null },
    ];
    const req = { ...requirement([[0], [1]]), evidenceFindingIndexes: [0, 1, 2] };
    expect(computeVerdictsForRequirements([req], flat, true)).toEqual(["implemented"]);
  });

  it("a criterion may not cite a finding the requirement itself does not cite", () => {
    const flat = [gated("implemented", { cites: [grounded] }), gated("gap-confirmed")];
    // AC2 points at finding 1, but the requirement only cites finding 0: AC2 has
    // no usable evidence, so the requirement cannot be partial.
    const req: VerdictRequirementInput = {
      evidenceFindingIndexes: [0],
      acceptanceCriteria: [AC1, AC2],
      criterionEvidence: [
        { criterion: AC1, evidenceFindingIndexes: [0] },
        { criterion: AC2, evidenceFindingIndexes: [1] },
      ],
    };
    expect(computeVerdictsForRequirements([req], flat, true)).toEqual(["could-not-verify"]);
  });

  it("matches criteria by text, whatever order the evidence lists them in", () => {
    const flat = [gated("implemented", { cites: [grounded] }), gated("gap-confirmed")];
    const req: VerdictRequirementInput = {
      evidenceFindingIndexes: [0, 1],
      acceptanceCriteria: [AC1, AC2],
      criterionEvidence: [
        { criterion: ` ${AC2} `, evidenceFindingIndexes: [1] },
        { criterion: AC1, evidenceFindingIndexes: [0] },
      ],
    };
    expect(computeVerdictsForRequirements([req], flat, true)).toEqual(["partial"]);
  });

  it("is null when the code agent never ran, per-criterion evidence or not", () => {
    const flat = [gated("implemented", { cites: [grounded] }), gated("gap-confirmed")];
    expect(computeVerdictsForRequirements([requirement([[0], [1]])], flat, false)).toEqual([null]);
  });
});

describe("#1610 — without per-criterion evidence the three-state rules apply unchanged", () => {
  const flat = [gated("implemented", { cites: [grounded] }), gated("gap-confirmed")];

  it.each<[string, VerdictRequirementInput]>([
    ["no acceptance criteria", { evidenceFindingIndexes: [0, 1] }],
    [
      "criteria but no criterionEvidence",
      { evidenceFindingIndexes: [0, 1], acceptanceCriteria: [AC1, AC2] },
    ],
    [
      "an empty criterionEvidence list",
      { evidenceFindingIndexes: [0, 1], acceptanceCriteria: [AC1, AC2], criterionEvidence: [] },
    ],
    [
      "criterionEvidence linking no criterion to any finding",
      {
        evidenceFindingIndexes: [0, 1],
        acceptanceCriteria: [AC1, AC2],
        criterionEvidence: [
          { criterion: AC1, evidenceFindingIndexes: [] },
          { criterion: "A criterion this requirement does not have", evidenceFindingIndexes: [0] },
        ],
      },
    ],
    [
      "criterionEvidence but no acceptance criteria",
      {
        evidenceFindingIndexes: [0, 1],
        criterionEvidence: [{ criterion: AC1, evidenceFindingIndexes: [0] }],
      },
    ],
  ])("%s → the legacy roll-up (gap beats implemented), never partial", (_name, req) => {
    expect(computeVerdictsForRequirements([req], flat, true)).toEqual(["gap-confirmed"]);
  });
});

describe("#1610 — the no-linked-criterion fallback is observable", () => {
  // An all-implemented fixture: the legacy roll-up reads `implemented`, whereas the
  // per-criterion path (no fallback) would read could-not-verify (nothing claimed
  // by a criterion, so no criterion verdict), distinguishing the two paths.
  const flat = [
    gated("implemented", { cites: [grounded] }),
    gated("implemented", { cites: [grounded] }),
  ];
  const doc: VerdictFindingInput = { agentKey: "docs", verdict: "gap-confirmed" };

  it("criterionEvidence linking no criterion to any finding → legacy implemented", () => {
    const req: VerdictRequirementInput = {
      evidenceFindingIndexes: [0, 1],
      acceptanceCriteria: [AC1, AC2],
      criterionEvidence: [
        { criterion: AC1, evidenceFindingIndexes: [] },
        { criterion: "A criterion this requirement does not have", evidenceFindingIndexes: [0] },
      ],
    };
    expect(computeVerdictsForRequirements([req], flat, true)).toEqual(["implemented"]);
  });

  it("a criterion linked only to a document finding does not count as evidence (falls back)", () => {
    const req = requirement([[2], []]);
    req.evidenceFindingIndexes = [0, 1, 2];
    expect(computeVerdictsForRequirements([req], [...flat, doc], true)).toEqual(["implemented"]);
  });
});
