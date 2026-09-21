/**
 * Issue #1112 (Epic #1107) — shared input-coverage primitives: the completeness
 * invariant, the "did this run discard user input?" predicate, and the capability
 * reason that stops such a run from reporting unqualified success (#1101).
 */
import { describe, expect, it } from "vitest";
import {
  deriveCapabilityReasons,
  hasDiscardedRequirementInputs,
  isRequirementInputAccountBalanced,
  requirementInputExcerpt,
  type CapabilityReasonInput,
  type RequirementInputAccount,
} from "./analysis.js";

function account(overrides: Partial<RequirementInputAccount> = {}): RequirementInputAccount {
  return {
    parsedCount: 1,
    analyzedIds: ["NR-1"],
    merged: [],
    dropped: [],
    inputTruncated: false,
    ...overrides,
  };
}

const CAPABLE_RUN: CapabilityReasonInput = {
  codeAnalysisRequested: true,
  databaseAnalysisRequested: false,
  codeGraphPresent: true,
  repoSourceIngested: true,
  fusedCodeRetrievalEnabled: true,
  schemaContextEnabled: true,
  agentMode: "agentic",
};

describe("isRequirementInputAccountBalanced", () => {
  it("holds when every parsed requirement lands in exactly one bucket", () => {
    expect(
      isRequirementInputAccountBalanced(
        account({
          parsedCount: 3,
          analyzedIds: ["NR-1"],
          merged: [{ id: "NR-2", excerpt: "b", mergedIntoId: "REQ-1", mergedIntoExcerpt: "orig" }],
          dropped: [{ id: "NR-3", excerpt: "c", reason: "candidate-cap" }],
        }),
      ),
    ).toBe(true);
  });

  it("fails when a parsed requirement is unaccounted for — the #1101 shape", () => {
    // Six of seven mapped, the seventh nowhere — exactly the run that reported success.
    expect(
      isRequirementInputAccountBalanced(
        account({
          parsedCount: 7,
          analyzedIds: ["NR-1", "NR-2", "NR-3", "NR-4", "NR-5", "NR-6"],
        }),
      ),
    ).toBe(false);
  });
});

describe("hasDiscardedRequirementInputs", () => {
  it("is true for a dropped requirement", () => {
    expect(
      hasDiscardedRequirementInputs(
        account({
          parsedCount: 2,
          dropped: [{ id: "NR-2", excerpt: "c", reason: "candidate-cap" }],
        }),
      ),
    ).toBe(true);
  });

  it("is true for a paste truncated at the input limit", () => {
    expect(hasDiscardedRequirementInputs(account({ inputTruncated: true }))).toBe(true);
  });

  it("is FALSE for a merge — a duplicate folded into a named survivor is not a loss", () => {
    expect(
      hasDiscardedRequirementInputs(
        account({
          parsedCount: 2,
          merged: [{ id: "NR-2", excerpt: "b", mergedIntoId: "NR-1", mergedIntoExcerpt: "a" }],
        }),
      ),
    ).toBe(false);
  });

  it("is false for a clean account, null, or undefined", () => {
    expect(hasDiscardedRequirementInputs(account())).toBe(false);
    expect(hasDiscardedRequirementInputs(null)).toBe(false);
    expect(hasDiscardedRequirementInputs(undefined)).toBe(false);
  });
});

describe("deriveCapabilityReasons — requirement-inputs-dropped (#1112)", () => {
  it("a run that dropped user input does NOT report unqualified success", () => {
    const reasons = deriveCapabilityReasons({
      ...CAPABLE_RUN,
      requirementInputAccount: account({
        parsedCount: 2,
        dropped: [{ id: "NR-2", excerpt: "order history", reason: "candidate-cap" }],
      }),
    });

    expect(reasons).toContain("requirement-inputs-dropped");
  });

  it("stays silent for a run whose inputs were all analyzed or merged", () => {
    expect(
      deriveCapabilityReasons({
        ...CAPABLE_RUN,
        requirementInputAccount: account({
          parsedCount: 2,
          merged: [{ id: "NR-2", excerpt: "b", mergedIntoId: "NR-1", mergedIntoExcerpt: "a" }],
        }),
      }),
    ).toEqual([]);
  });

  it("reports the loss even when no code agent was requested — it is the USER's input", () => {
    const reasons = deriveCapabilityReasons({
      codeAnalysisRequested: false,
      databaseAnalysisRequested: false,
      codeGraphPresent: false,
      repoSourceIngested: false,
      fusedCodeRetrievalEnabled: true,
      schemaContextEnabled: true,
      requirementInputAccount: account({ inputTruncated: true }),
    });

    expect(reasons).toEqual(["requirement-inputs-dropped"]);
  });

  it("is absent on runs with no account at all (pre-#1112 and plain runs)", () => {
    expect(deriveCapabilityReasons(CAPABLE_RUN)).toEqual([]);
  });
});

describe("requirementInputExcerpt", () => {
  it("returns short text unchanged", () => {
    expect(requirementInputExcerpt("Add /api/status.")).toBe("Add /api/status.");
  });

  it("respects an explicit maximum", () => {
    expect(requirementInputExcerpt("abcdefghij", 5)).toBe("abcd…");
  });
});
