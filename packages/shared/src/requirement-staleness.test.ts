/**
 * #2222 — the wire shapes and wording of stale analysis results: governing
 * findings judged on an older wording of a requirement, and the analysis
 * findings a requirement edited since the analysis was synthesised from.
 */
import { describe, expect, it } from "vitest";
import { requirementFindingsStale, requirementFindingsStaleNote } from "./analysis.js";
import {
  governingFindingSchema,
  governingRecheckInputSchema,
  governingRequirementApplicabilitySchema,
  governingStaleNote,
} from "./governing.js";

describe("governingStaleNote", () => {
  it("names each changed requirement and its versions", () => {
    expect(
      governingStaleNote([
        { requirementId: "r1", title: "Minimum length", judgedVersion: 0, currentVersion: 2 },
        { requirementId: "r2", title: "Reset page", judgedVersion: 1, currentVersion: 3 },
      ]),
    ).toBe(
      'Stale: "Minimum length" was checked at v0 and is now v2; "Reset page" was checked at v1 and is now v3. This result judges the earlier wording.',
    );
  });

  it("is null when nothing is stale", () => {
    expect(governingStaleNote([])).toBeNull();
  });
});

describe("requirementFindingsStale", () => {
  it("is set only when the analysed version is known and not the current one", () => {
    expect(requirementFindingsStale({ version: 2, analysedVersion: 0 })).toEqual({
      judgedVersion: 0,
      currentVersion: 2,
    });
    expect(requirementFindingsStale({ version: 2, analysedVersion: 2 })).toBeNull();
    expect(requirementFindingsStale({ version: 2 })).toBeNull();
    expect(requirementFindingsStale({ version: 2, analysedVersion: null })).toBeNull();
  });

  it("says which version the analysis judged", () => {
    expect(requirementFindingsStaleNote({ judgedVersion: 0, currentVersion: 2 })).toBe(
      "Stale: the analysis judged v0; the requirement is now v2.",
    );
  });
});

describe("the #2222 schemas", () => {
  it("a re-check names one requirement and nothing else", () => {
    expect(governingRecheckInputSchema.safeParse({ requirementId: "r1" }).success).toBe(true);
    expect(governingRecheckInputSchema.safeParse({}).success).toBe(false);
    expect(
      governingRecheckInputSchema.safeParse({ requirementId: "r1", actorId: "u" }).success,
    ).toBe(false);
  });

  it("an applicability entry may carry the versions it judged, as non-negative integers", () => {
    const entry = { requirementId: "r1", text: "t", decisions: [] };
    expect(governingRequirementApplicabilitySchema.safeParse(entry).success).toBe(true);
    expect(
      governingRequirementApplicabilitySchema.safeParse({ ...entry, versions: { r1: 2 } }).success,
    ).toBe(true);
    expect(
      governingRequirementApplicabilitySchema.safeParse({ ...entry, versions: { r1: -1 } }).success,
    ).toBe(false);
  });

  it("a finding may carry its judged versions and its stale requirements", () => {
    const shape = governingFindingSchema.pick({ requirementVersions: true, stale: true });
    expect(shape.safeParse({}).success).toBe(true);
    expect(
      shape.safeParse({
        requirementVersions: { r1: 1 },
        stale: [{ requirementId: "r1", title: "T", judgedVersion: 1, currentVersion: 2 }],
      }).success,
    ).toBe(true);
    expect(shape.safeParse({ stale: [{ requirementId: "r1" }] }).success).toBe(false);
  });
});
