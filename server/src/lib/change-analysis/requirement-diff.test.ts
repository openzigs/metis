/**
 * Tests for the current-vs-proposed aggregator (#743). Proves the diff is
 * COMPOSED from the Change Analysis engine's exported matcher/scorers and the
 * #742 gap reports — not a reimplementation. Each case feeds requirement + gap
 * fixtures and asserts the assembled current/proposed sides.
 */
import { describe, it, expect } from "vitest";
import type { GapReport, GapReportRequirement, CodeCitation } from "@metis/shared";
import { buildRequirementDiff, type RequirementDiffRequirementInput } from "./requirement-diff.js";

function req(
  overrides: Partial<RequirementDiffRequirementInput> & { id: string },
): RequirementDiffRequirementInput {
  return {
    title: "Users can log in",
    body: "Users authenticate with email and password.",
    type: "feature",
    priority: "high",
    labels: "",
    storyPoints: 3,
    parentId: null,
    ...overrides,
  };
}

function citation(filePath: string): CodeCitation {
  return { filePath, startLine: 1, endLine: 10, symbolId: `sym-${filePath}` };
}

function gapReqEntry(requirementId: string, citations: CodeCitation[]): GapReportRequirement {
  return {
    requirementId,
    title: "t",
    body: "b",
    priority: "high",
    coverage: citations.length > 0 ? "grounded_in_code" : "no_evidence",
    storyPoints: 3,
    verificationStatus: citations.length > 0 ? "confirmed" : null,
    currentImplementation: {
      hasEvidence: citations.length > 0,
      citations,
      citedFindingCount: citations.length,
    },
    gapFindings: [],
    noEvidence: citations.length === 0,
  };
}

function gapReport(analysisId: string, entries: GapReportRequirement[]): GapReport {
  return { analysisId, projectId: "proj-1", requirements: entries };
}

describe("buildRequirementDiff", () => {
  it("returns an empty diff (explicit empty state) when there is no base run", () => {
    const diff = buildRequirementDiff({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: null,
      base: null,
      head: { requirements: [req({ id: "r1" })], gapReport: null },
    });
    expect(diff.baseAnalysisId).toBeNull();
    expect(diff.entries).toEqual([]);
    expect(diff.summary).toEqual({ total: 0, added: 0, removed: 0, modified: 0 });
  });

  it("assembles a modified requirement with BOTH current and proposed sides + evidence", () => {
    const base = req({
      id: "b1",
      title: "Users can log in",
      body: "Users authenticate with email and password.",
    });
    const head = req({
      id: "h1",
      title: "Users can log in", // similar title ⇒ engine matches the pair
      body: "Users authenticate with email and password and are locked out after 5 failures.",
    });

    const diff = buildRequirementDiff({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: "an-base",
      base: {
        requirements: [base],
        gapReport: gapReport("an-base", [gapReqEntry("b1", [citation("auth.ts")])]),
      },
      head: {
        requirements: [head],
        gapReport: gapReport("an-head", [gapReqEntry("h1", [])]),
      },
    });

    expect(diff.summary.modified).toBe(1);
    expect(diff.summary.total).toBe(1);
    const entry = diff.entries[0]!;
    expect(entry.changeType).toBe("modified");
    // current side = base requirement + base code evidence
    expect(entry.current).not.toBeNull();
    expect(entry.current!.requirementId).toBe("b1");
    expect(entry.current!.codeCitations).toEqual([citation("auth.ts")]);
    expect(entry.current!.hasEvidence).toBe(true);
    // proposed side = head requirement + head gap report
    expect(entry.proposed).not.toBeNull();
    expect(entry.proposed!.requirementId).toBe("h1");
    expect(entry.proposed!.gapReport).not.toBeNull();
    // engine-produced fields present
    expect(entry.diffSummary).toContain("Body content modified");
    expect(entry.severity).toBeDefined();
    expect(entry.impactScore).toBeGreaterThan(0);
  });

  it("excludes a matched requirement that did not materially change", () => {
    const same = {
      title: "Users can log in",
      body: "Users authenticate with email and password.",
      type: "feature",
      priority: "high" as const,
      labels: "",
      storyPoints: 3,
      parentId: null,
    };
    const diff = buildRequirementDiff({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: "an-base",
      base: { requirements: [{ id: "b1", ...same }], gapReport: null },
      head: { requirements: [{ id: "h1", ...same }], gapReport: null },
    });
    expect(diff.entries).toEqual([]);
    expect(diff.summary.total).toBe(0);
  });

  it("marks an added requirement with a proposed side and NO current", () => {
    const diff = buildRequirementDiff({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: "an-base",
      base: { requirements: [req({ id: "b1", title: "Existing report export" })], gapReport: null },
      head: {
        requirements: [
          req({ id: "b1x", title: "Existing report export" }),
          req({ id: "h-new", title: "Two factor authentication support" }),
        ],
        gapReport: gapReport("an-head", [gapReqEntry("h-new", [citation("mfa.ts")])]),
      },
    });
    const added = diff.entries.find((e) => e.changeType === "added");
    expect(added).toBeDefined();
    expect(added!.current).toBeNull();
    expect(added!.proposed!.requirementId).toBe("h-new");
    expect(added!.proposed!.gapReport!.currentImplementation.citations).toEqual([
      citation("mfa.ts"),
    ]);
    expect(added!.diffSummary).toContain("New");
    expect(diff.summary.added).toBe(1);
  });

  it("marks a removed requirement with a current side (evidence) and NO proposed", () => {
    const diff = buildRequirementDiff({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: "an-base",
      base: {
        requirements: [
          req({ id: "keep", title: "Keep me around please" }),
          req({ id: "gone", title: "Legacy SOAP endpoint compatibility" }),
        ],
        gapReport: gapReport("an-base", [gapReqEntry("gone", [citation("soap.ts")])]),
      },
      head: {
        requirements: [req({ id: "keep2", title: "Keep me around please" })],
        gapReport: null,
      },
    });
    const removed = diff.entries.find((e) => e.changeType === "removed");
    expect(removed).toBeDefined();
    expect(removed!.proposed).toBeNull();
    expect(removed!.current!.requirementId).toBe("gone");
    expect(removed!.current!.codeCitations).toEqual([citation("soap.ts")]);
    expect(removed!.diffSummary).toContain("removed");
    expect(diff.summary.removed).toBe(1);
  });

  it("renders a modified current side with no evidence when the base gap report lacks code", () => {
    const diff = buildRequirementDiff({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: "an-base",
      base: {
        requirements: [req({ id: "b1", body: "short body" })],
        gapReport: gapReport("an-base", [gapReqEntry("b1", [])]),
      },
      head: {
        requirements: [req({ id: "h1", body: "a substantially longer body that clearly changed" })],
        gapReport: null,
      },
    });
    const entry = diff.entries[0]!;
    expect(entry.changeType).toBe("modified");
    expect(entry.current!.hasEvidence).toBe(false);
    expect(entry.current!.codeCitations).toEqual([]);
  });
});
