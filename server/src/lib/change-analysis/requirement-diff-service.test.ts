/**
 * Tests for the requirement-diff SERVICE (#743). Proves assembly from persisted
 * data via injected loaders — the real aggregator + real Change Analysis engine
 * matcher run over fixture requirement rows (no stubbed builder internals). Also
 * covers base auto-resolution and the no-base empty state.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import type { GapReport, CodeCitation } from "@metis/shared";

const { analysisFindFirst, requirementFindMany } = vi.hoisted(() => ({
  analysisFindFirst: vi.fn(),
  requirementFindMany: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    analysis: { findFirst: analysisFindFirst },
    requirement: { findMany: requirementFindMany },
  },
}));

import { getRequirementDiff } from "./requirement-diff-service.js";
import type {
  RequirementDiffAnalysisMeta,
  RequirementDiffDeps,
} from "./requirement-diff-service.js";
import type { RequirementDiffRequirementInput } from "./requirement-diff.js";

function meta(id: string, startedAt: string): RequirementDiffAnalysisMeta {
  return { id, status: "completed", startedAt: new Date(startedAt) };
}

function reqRow(id: string, title: string, body: string): RequirementDiffRequirementInput {
  return {
    id,
    title,
    body,
    type: "feature",
    priority: "high",
    labels: "",
    storyPoints: 3,
    parentId: null,
  };
}

function citation(filePath: string): CodeCitation {
  return { filePath, startLine: 1, endLine: 5, symbolId: `sym-${filePath}` };
}

function gapReportWith(
  analysisId: string,
  requirementId: string,
  cites: CodeCitation[],
): GapReport {
  return {
    analysisId,
    projectId: "proj-1",
    requirements: [
      {
        requirementId,
        title: "t",
        body: "b",
        priority: "high",
        coverage: cites.length ? "grounded_in_code" : "no_evidence",
        storyPoints: 3,
        verificationStatus: cites.length ? "confirmed" : null,
        currentImplementation: {
          hasEvidence: cites.length > 0,
          citations: cites,
          citedFindingCount: cites.length,
        },
        gapFindings: [],
        noEvidence: cites.length === 0,
      },
    ],
  };
}

describe("getRequirementDiff", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when the head analysis is not visible", async () => {
    const deps: RequirementDiffDeps = {
      loadAnalysisMeta: vi.fn().mockResolvedValue(null),
    };
    const diff = await getRequirementDiff({ projectId: "proj-1", headAnalysisId: "missing" }, deps);
    expect(diff).toBeNull();
  });

  it("returns an empty diff when no previous run exists (empty state)", async () => {
    const deps: RequirementDiffDeps = {
      loadAnalysisMeta: vi.fn().mockResolvedValue(meta("an-head", "2026-07-10T00:00:00Z")),
      findPreviousAnalysisId: vi.fn().mockResolvedValue(null),
      loadRequirements: vi.fn(),
      loadGapReport: vi.fn(),
    };
    const diff = await getRequirementDiff({ projectId: "proj-1", headAnalysisId: "an-head" }, deps);
    expect(diff).not.toBeNull();
    expect(diff!.baseAnalysisId).toBeNull();
    expect(diff!.entries).toEqual([]);
    // No requirement/gap loads when there is nothing to compare against.
    expect(deps.loadRequirements).not.toHaveBeenCalled();
  });

  it("auto-resolves the previous run and assembles a modified diff from persisted rows", async () => {
    const reqsByAnalysis: Record<string, RequirementDiffRequirementInput[]> = {
      "an-base": [reqRow("b1", "User login", "email + password")],
      "an-head": [
        reqRow("h1", "User login", "email + password and account lockout after repeated failures"),
      ],
    };
    const gapByAnalysis: Record<string, GapReport> = {
      "an-base": gapReportWith("an-base", "b1", [citation("auth.ts")]),
      "an-head": gapReportWith("an-head", "h1", []),
    };

    const deps: RequirementDiffDeps = {
      loadAnalysisMeta: vi
        .fn()
        .mockImplementation(async (id: string) =>
          id === "an-head" ? meta("an-head", "2026-07-10T00:00:00Z") : null,
        ),
      findPreviousAnalysisId: vi.fn().mockResolvedValue("an-base"),
      loadRequirements: vi.fn().mockImplementation(async (id: string) => reqsByAnalysis[id] ?? []),
      loadGapReport: vi.fn().mockImplementation(async (id: string) => gapByAnalysis[id] ?? null),
    };

    const diff = await getRequirementDiff({ projectId: "proj-1", headAnalysisId: "an-head" }, deps);

    expect(diff!.baseAnalysisId).toBe("an-base");
    expect(diff!.summary.modified).toBe(1);
    const entry = diff!.entries[0]!;
    expect(entry.changeType).toBe("modified");
    expect(entry.current!.codeCitations).toEqual([citation("auth.ts")]);
    expect(entry.proposed!.requirementId).toBe("h1");
    expect(deps.findPreviousAnalysisId).toHaveBeenCalledWith(
      "proj-1",
      "an-head",
      new Date("2026-07-10T00:00:00Z"),
    );
  });

  it("uses an explicit, project-scoped base and ignores a non-completed one", async () => {
    const metas: Record<string, RequirementDiffAnalysisMeta> = {
      "an-head": meta("an-head", "2026-07-10T00:00:00Z"),
      "an-base": { id: "an-base", status: "running", startedAt: new Date("2026-07-01T00:00:00Z") },
    };
    const deps: RequirementDiffDeps = {
      loadAnalysisMeta: vi.fn().mockImplementation(async (id: string) => metas[id] ?? null),
      findPreviousAnalysisId: vi.fn(),
      loadRequirements: vi.fn().mockResolvedValue([]),
      loadGapReport: vi.fn().mockResolvedValue(null),
    };
    const diff = await getRequirementDiff(
      { projectId: "proj-1", headAnalysisId: "an-head", baseAnalysisId: "an-base" },
      deps,
    );
    // Base not completed ⇒ treated as no comparison; falls through to empty diff.
    expect(diff!.baseAnalysisId).toBeNull();
    expect(diff!.entries).toEqual([]);
    // Explicit base path never auto-resolves a previous run.
    expect(deps.findPreviousAnalysisId).not.toHaveBeenCalled();
  });

  it("uses an explicit completed base and assembles a modified diff", async () => {
    const metas: Record<string, RequirementDiffAnalysisMeta> = {
      "an-head": meta("an-head", "2026-07-10T00:00:00Z"),
      "an-base": meta("an-base", "2026-07-01T00:00:00Z"),
    };
    const reqsByAnalysis: Record<string, RequirementDiffRequirementInput[]> = {
      "an-base": [reqRow("b1", "Login", "email + password")],
      "an-head": [reqRow("h1", "Login", "email + password with mandatory 2FA enforcement")],
    };
    const deps: RequirementDiffDeps = {
      loadAnalysisMeta: vi.fn().mockImplementation(async (id: string) => metas[id] ?? null),
      findPreviousAnalysisId: vi.fn(),
      loadRequirements: vi.fn().mockImplementation(async (id: string) => reqsByAnalysis[id] ?? []),
      loadGapReport: vi.fn().mockResolvedValue(null),
    };
    const diff = await getRequirementDiff(
      { projectId: "proj-1", headAnalysisId: "an-head", baseAnalysisId: "an-base" },
      deps,
    );
    expect(diff!.baseAnalysisId).toBe("an-base");
    expect(diff!.summary.modified).toBe(1);
    expect(deps.findPreviousAnalysisId).not.toHaveBeenCalled();
  });

  it("resolves through the default prisma-backed loaders when no deps are injected", async () => {
    // head lookup, previous-run lookup, then base lookup (explicit path not taken).
    analysisFindFirst
      .mockResolvedValueOnce({
        id: "an-head",
        status: "completed",
        startedAt: new Date("2026-07-10T00:00:00Z"),
      })
      // findPreviousAnalysisId
      .mockResolvedValueOnce({ id: "an-base" });
    requirementFindMany.mockImplementation(async ({ where }: { where: { analysisId: string } }) => {
      if (where.analysisId === "an-head") {
        return [
          {
            id: "h1",
            title: "Login",
            body: "email + password with lockout after repeated failures",
            type: "feature",
            priority: "high",
            labels: "",
            storyPoints: 3,
            parentId: null,
          },
        ];
      }
      return [
        {
          id: "b1",
          title: "Login",
          body: "email + password",
          type: "feature",
          priority: "weird-priority", // exercises coercePriority default
          labels: "",
          storyPoints: 3,
          parentId: null,
        },
      ];
    });

    const diff = await getRequirementDiff(
      { projectId: "proj-1", headAnalysisId: "an-head" },
      { loadGapReport: vi.fn().mockResolvedValue(null) },
    );

    expect(diff!.baseAnalysisId).toBe("an-base");
    expect(diff!.summary.modified).toBe(1);
    expect(diff!.entries[0]!.current!.priority).toBe("medium");
    // Default findPrevious was invoked with a project-scoped, completed filter.
    expect(analysisFindFirst).toHaveBeenNthCalledWith(2, {
      where: {
        projectId: "proj-1",
        deletedAt: null,
        status: "completed",
        id: { not: "an-head" },
        startedAt: { lt: new Date("2026-07-10T00:00:00Z") },
      },
      orderBy: { startedAt: "desc" },
      select: { id: true },
    });
  });
});
