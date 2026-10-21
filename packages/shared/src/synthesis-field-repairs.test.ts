/**
 * Issue #1099 — the wording of a synthesis field repair. These fields are
 * published to trackers and Spec Kit, so each sentence must name the
 * requirement and say what was lost.
 */
import { describe, expect, it } from "vitest";
import {
  SYNTHESIS_REPAIR_ACTIONS,
  SYNTHESIS_REPAIRABLE_FIELDS,
  describeSynthesisFieldRepair,
  describeSynthesisFieldRepairs,
  readSynthesisFieldRepairs,
  type SynthesisFieldRepair,
} from "./synthesis-field-repairs.js";

const rep = (over: Partial<SynthesisFieldRepair>): SynthesisFieldRepair => ({
  field: "storyPoints",
  action: "dropped",
  requirementNumber: 2,
  requirementTitle: "Limit export size",
  ...over,
});

describe("describeSynthesisFieldRepair", () => {
  it("names the requirement and what was lost", () => {
    expect(describeSynthesisFieldRepair(rep({}))).toBe(
      "“Limit export size”: story points left blank (the model's value was not a whole number from 0 to 100).",
    );
  });

  it("says which default replaced an unknown type or priority", () => {
    expect(describeSynthesisFieldRepair(rep({ field: "type", action: "defaulted" }))).toContain(
      'type set to "feature"',
    );
    expect(describeSynthesisFieldRepair(rep({ field: "priority", action: "defaulted" }))).toContain(
      'priority set to "medium"',
    );
  });

  it("falls back to the requirement number when it had no title", () => {
    expect(
      describeSynthesisFieldRepair(
        rep({ field: "requirement", action: "requirement-dropped", requirementTitle: null }),
      ),
    ).toBe("Requirement 2: left out: it had no usable title or description.");
  });

  it("words reply-level repairs as a sentence", () => {
    expect(
      describeSynthesisFieldRepair(
        rep({ field: "requirements", action: "truncated", requirementNumber: null }),
      ),
    ).toBe("Only the first 100 requirements were kept.");
  });

  it("words every field and action without throwing", () => {
    for (const field of SYNTHESIS_REPAIRABLE_FIELDS) {
      for (const action of SYNTHESIS_REPAIR_ACTIONS) {
        expect(describeSynthesisFieldRepair(rep({ field, action })).length).toBeGreaterThan(10);
      }
    }
  });

  it("counts values in the lead sentence", () => {
    expect(describeSynthesisFieldRepairs({ repairs: [rep({})], total: 1, at: "" })).toContain(
      "1 value METIS could not use",
    );
    expect(describeSynthesisFieldRepairs({ repairs: [rep({})], total: 3, at: "" })).toContain(
      "3 values METIS could not use",
    );
  });
});

describe("readSynthesisFieldRepairs", () => {
  it("keeps valid entries, drops unknown ones and keeps total honest", () => {
    const read = readSynthesisFieldRepairs({
      repairs: [rep({}), { field: "nope", action: "dropped" }],
      total: 1,
      at: "t",
    });
    expect(read?.repairs).toEqual([rep({})]);
    expect(read?.total).toBe(1);
    expect(readSynthesisFieldRepairs({ repairs: [rep({})], total: 9, at: "t" })?.total).toBe(9);
  });

  it("returns null for absent or malformed values", () => {
    expect(readSynthesisFieldRepairs(undefined)).toBeNull();
    expect(readSynthesisFieldRepairs({ repairs: "x" })).toBeNull();
    expect(readSynthesisFieldRepairs({ repairs: [] })).toBeNull();
  });
});
