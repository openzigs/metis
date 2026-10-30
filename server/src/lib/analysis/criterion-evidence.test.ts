/**
 * Issue #1610 — per-criterion evidence travels with its criterion.
 *
 * The model answers with `acceptanceCriteriaEvidence`, a list ALIGNED with its
 * own `acceptanceCriteria`. That alignment breaks the moment a criterion is
 * dropped, merged or rebuilt, so the reply repair zips it into
 * `criterionEvidence` keyed by criterion text BEFORE any criterion is touched,
 * and every later step carries the keyed form. These tests pin each hop.
 */
import { describe, expect, it } from "vitest";
import type { SynthesisFieldRepair, SynthesizedRequirement } from "@metis/shared";
import { repairSynthesizedRequirement } from "./synthesis-reply-repair.js";
import { buildApprovedRequirementSet } from "./approved-requirement-set.js";
import type { StructuredRequirement } from "./types/requirements.js";

const A = "POST /orders rejects a quantity above stock with 409.";
const B = "INVENTORY.QTY never goes below zero.";
const C = "The stock check runs inside the order transaction.";

function repair(raw: Record<string, unknown>): Record<string, unknown> {
  const out: SynthesisFieldRepair[] = [];
  return repairSynthesizedRequirement({ title: "t", body: "b", ...raw }, 1, out)!;
}

describe("#1610 — the reply repair zips aligned evidence into criterionEvidence", () => {
  it("keys each criterion's findings by its text, and drops the aligned field", () => {
    const r = repair({ acceptanceCriteria: [A, B], acceptanceCriteriaEvidence: [[0, 2], [1]] });
    expect(r.criterionEvidence).toEqual([
      { criterion: A, evidenceFindingIndexes: [0, 2] },
      { criterion: B, evidenceFindingIndexes: [1] },
    ]);
    expect(r).not.toHaveProperty("acceptanceCriteriaEvidence");
  });

  it("keeps the alignment when a bad criterion in the middle is dropped", () => {
    const r = repair({
      acceptanceCriteria: [A, "x".repeat(2000), C],
      acceptanceCriteriaEvidence: [[0], [1], [2]],
    });
    // The over-long criterion is gone, and so is its evidence — C keeps [2], not [1].
    expect(r.acceptanceCriteria).toEqual([A, C]);
    expect(r.criterionEvidence).toEqual([
      { criterion: A, evidenceFindingIndexes: [0] },
      { criterion: C, evidenceFindingIndexes: [2] },
    ]);
  });

  it("trims the criterion key the same way the criterion itself is trimmed", () => {
    const r = repair({ acceptanceCriteria: [`  ${A}  `], acceptanceCriteriaEvidence: [[0]] });
    expect(r.acceptanceCriteria).toEqual([A]);
    expect(r.criterionEvidence).toEqual([{ criterion: A, evidenceFindingIndexes: [0] }]);
  });

  it("drops non-index entries and duplicates, and skips a criterion whose entry is not a list", () => {
    const r = repair({
      acceptanceCriteria: [A, B, C],
      acceptanceCriteriaEvidence: [[0, 0, -1, 1.5, "2", 3], null, [4]],
    });
    expect(r.criterionEvidence).toEqual([
      { criterion: A, evidenceFindingIndexes: [0, 3] },
      { criterion: C, evidenceFindingIndexes: [4] },
    ]);
  });

  it.each([
    ["absent", {}],
    ["not a list", { acceptanceCriteriaEvidence: "0,1" }],
    ["null", { acceptanceCriteriaEvidence: null }],
    ["a list of non-lists", { acceptanceCriteriaEvidence: [0, 1] }],
  ])("leaves criterionEvidence absent when the aligned field is %s", (_n, extra) => {
    const r = repair({ acceptanceCriteria: [A, B], ...extra });
    expect(r).not.toHaveProperty("criterionEvidence");
    expect(r).not.toHaveProperty("acceptanceCriteriaEvidence");
  });

  it("leaves it absent when there are no criteria to align with", () => {
    const r = repair({ acceptanceCriteria: "not a list", acceptanceCriteriaEvidence: [[0]] });
    expect(r).not.toHaveProperty("criterionEvidence");
  });

  it("never keeps a criterionEvidence the model wrote itself", () => {
    const r = repair({
      acceptanceCriteria: [A],
      criterionEvidence: [{ criterion: A, evidenceFindingIndexes: [0] }],
    });
    expect(r).not.toHaveProperty("criterionEvidence");
  });
});

function structured(id: string, title: string): StructuredRequirement {
  return {
    id,
    title,
    description: title,
    type: "functional",
    stakeholders: [],
    priority: "must-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  };
}

function synth(title: string, extra: Partial<SynthesizedRequirement>): SynthesizedRequirement {
  return {
    type: "feature",
    title,
    body: title,
    priority: "medium",
    labels: [],
    evidenceFindingIndexes: [],
    acceptanceCriteria: [],
    ...extra,
  };
}

describe("#1610 — the approval checkpoint carries criterionEvidence with the criteria", () => {
  it("a single matched item hands its per-criterion evidence to the approved requirement", () => {
    const out = buildApprovedRequirementSet({
      structured: [structured("REQ-1", "Never oversell")],
      approvedIds: new Set(["REQ-1"]),
      synthesis: {
        summary: "s",
        requirements: [
          synth("Never oversell", {
            evidenceFindingIndexes: [0, 1],
            acceptanceCriteria: [A, B],
            criterionEvidence: [
              { criterion: A, evidenceFindingIndexes: [0] },
              { criterion: B, evidenceFindingIndexes: [1] },
            ],
            structuredIds: ["REQ-1"],
          }),
        ],
      },
    });
    expect(out.requirements[0]!.criterionEvidence).toEqual([
      { criterion: A, evidenceFindingIndexes: [0] },
      { criterion: B, evidenceFindingIndexes: [1] },
    ]);
  });

  it("several items joined into one requirement keep every item's per-criterion evidence", () => {
    const out = buildApprovedRequirementSet({
      structured: [structured("REQ-1", "Never oversell")],
      approvedIds: new Set(["REQ-1"]),
      synthesis: {
        summary: "s",
        requirements: [
          synth("Validate stock", {
            evidenceFindingIndexes: [0],
            acceptanceCriteria: [A],
            criterionEvidence: [{ criterion: A, evidenceFindingIndexes: [0] }],
            structuredIds: ["REQ-1"],
          }),
          synth("Constrain stock", {
            evidenceFindingIndexes: [1],
            acceptanceCriteria: [B],
            criterionEvidence: [{ criterion: B, evidenceFindingIndexes: [1] }],
            structuredIds: ["REQ-1"],
          }),
        ],
      },
    });
    const [row] = out.requirements;
    expect(row!.acceptanceCriteria).toEqual([A, B]);
    expect(row!.criterionEvidence).toEqual([
      { criterion: A, evidenceFindingIndexes: [0] },
      { criterion: B, evidenceFindingIndexes: [1] },
    ]);
  });

  it("an item with no per-criterion evidence leaves the field absent", () => {
    const out = buildApprovedRequirementSet({
      structured: [structured("REQ-1", "Never oversell")],
      approvedIds: new Set(["REQ-1"]),
      synthesis: {
        summary: "s",
        requirements: [
          synth("Validate stock", {
            evidenceFindingIndexes: [0],
            acceptanceCriteria: [A],
            structuredIds: ["REQ-1"],
          }),
          synth("Constrain stock", {
            evidenceFindingIndexes: [1],
            acceptanceCriteria: [B],
            structuredIds: ["REQ-1"],
          }),
        ],
      },
    });
    expect(out.requirements[0]).not.toHaveProperty("criterionEvidence");
  });
});
