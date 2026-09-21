/**
 * Tests for the change analysis engine — Epic #557 / Issue #564.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- Prisma mock -----------------------------------------------------------

type RequirementRow = {
  id: string;
  title: string;
  body: string;
  type: string;
  priority: string;
  labels: string;
  storyPoints: number | null;
  parentId: string | null;
  analysisId: string;
  projectId: string;
  deletedAt: null | Date;
};

type AnalysisRow = {
  id: string;
  projectId: string;
  status: string;
  deletedAt: null | Date;
};

type ChangeAnalysisRow = {
  id: string;
  projectId: string;
  baseAnalysisId: string;
  headAnalysisId: string;
  status: string;
  summary: string | null;
  totalChanges: number;
  additions: number;
  removals: number;
  modifications: number;
  startedById: string;
  startedAt: Date;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type ChangeRow = {
  id: string;
  changeAnalysisId: string;
  changeType: string;
  severity: string;
  impactScore: number;
  requirementId: string | null;
  previousRequirementId: string | null;
  title: string;
  previousTitle: string | null;
  body: string;
  previousBody: string | null;
  diffSummary: string | null;
  reviewStatus: string;
  reviewedById: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
};

const analyses = new Map<string, AnalysisRow>();
const requirements = new Map<string, RequirementRow>();
const changeAnalyses = new Map<string, ChangeAnalysisRow>();
const changes = new Map<string, ChangeRow>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    analysis: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
        const row = analyses.get(where.id);
        if (!row) return null;
        if (where.projectId && row.projectId !== where.projectId) return null;
        return row;
      }),
    },
    requirement: {
      findMany: vi.fn(async ({ where }: { where: { analysisId: string; deletedAt?: null } }) => {
        return [...requirements.values()].filter(
          (r) => r.analysisId === where.analysisId && !r.deletedAt,
        );
      }),
    },
    changeAnalysis: {
      create: vi.fn(async ({ data }: { data: Partial<ChangeAnalysisRow> }) => {
        nextId++;
        const row: ChangeAnalysisRow = {
          id: `ca_${nextId}`,
          projectId: data.projectId ?? "proj_1",
          baseAnalysisId: data.baseAnalysisId ?? "",
          headAnalysisId: data.headAnalysisId ?? "",
          status: data.status ?? "pending",
          summary: data.summary ?? null,
          totalChanges: data.totalChanges ?? 0,
          additions: data.additions ?? 0,
          removals: data.removals ?? 0,
          modifications: data.modifications ?? 0,
          startedById: data.startedById ?? "user_1",
          startedAt: new Date(),
          completedAt: null,
          errorMessage: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        changeAnalyses.set(row.id, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = changeAnalyses.get(where.id);
        return row ?? null;
      }),
      findFirst: vi.fn(async ({ where }: { where: { id: string; projectId?: string } }) => {
        const row = changeAnalyses.get(where.id);
        if (!row) return null;
        if (where.projectId !== undefined && row.projectId !== where.projectId) return null;
        return {
          ...row,
          changes: [...changes.values()].filter((c) => c.changeAnalysisId === row.id),
        };
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = changeAnalyses.get(where.id);
        if (!row) throw new Error("not found");
        return row;
      }),
      findMany: vi.fn(async ({ where }: { where: { projectId: string } }) => {
        return [...changeAnalyses.values()]
          .filter((ca) => ca.projectId === where.projectId)
          .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ChangeAnalysisRow> }) => {
          const row = changeAnalyses.get(where.id);
          if (!row) throw new Error("not found");
          const updated = { ...row, ...data, updatedAt: new Date() };
          changeAnalyses.set(where.id, updated);
          return updated;
        },
      ),
    },
    requirementChange: {
      createMany: vi.fn(async ({ data }: { data: Partial<ChangeRow>[] }) => {
        for (const d of data) {
          nextId++;
          const row: ChangeRow = {
            id: `rc_${nextId}`,
            changeAnalysisId: d.changeAnalysisId ?? "",
            changeType: d.changeType ?? "modified",
            severity: d.severity ?? "medium",
            impactScore: d.impactScore ?? 0.5,
            requirementId: d.requirementId ?? null,
            previousRequirementId: d.previousRequirementId ?? null,
            title: d.title ?? "",
            previousTitle: d.previousTitle ?? null,
            body: d.body ?? "",
            previousBody: d.previousBody ?? null,
            diffSummary: d.diffSummary ?? null,
            reviewStatus: d.reviewStatus ?? "pending",
            reviewedById: null,
            reviewedAt: null,
            createdAt: new Date(),
          };
          changes.set(row.id, row);
        }
        return { count: data.length };
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            id: string;
            changeAnalysisId?: string;
            changeAnalysis?: { projectId?: string };
          };
        }) => {
          const row = changes.get(where.id);
          if (!row) return null;
          if (where.changeAnalysisId && row.changeAnalysisId !== where.changeAnalysisId) {
            return null;
          }
          const wantedProject = where.changeAnalysis?.projectId;
          if (wantedProject !== undefined) {
            const parent = changeAnalyses.get(row.changeAnalysisId);
            if (!parent || parent.projectId !== wantedProject) return null;
          }
          return row;
        },
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ChangeRow> }) => {
          const row = changes.get(where.id);
          if (!row) throw new Error("not found");
          const updated = { ...row, ...data };
          changes.set(where.id, updated);
          return updated;
        },
      ),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  titleSimilarity,
  computeSeverity,
  computeImpactScore,
  generateDiffSummary,
  matchRequirements,
  triggerChangeAnalysis,
  listChangeAnalyses,
  getChangeAnalysis,
  reviewChange,
  ChangeAnalysisError,
} from "../src/lib/change-analysis/change-analysis-engine.js";

beforeEach(() => {
  analyses.clear();
  requirements.clear();
  changeAnalyses.clear();
  changes.clear();
  nextId = 0;
});

afterEach(() => vi.clearAllMocks());

// ---- Pure function tests ---------------------------------------------------

describe("titleSimilarity", () => {
  it("returns 1 for identical titles", () => {
    expect(titleSimilarity("User Authentication", "User Authentication")).toBe(1);
  });

  it("returns 0 for completely different titles", () => {
    expect(titleSimilarity("User Auth", "Database Migration")).toBeLessThan(0.3);
  });

  it("returns high similarity for minor changes", () => {
    const sim = titleSimilarity(
      "Implement user login feature",
      "Implement user login functionality",
    );
    expect(sim).toBeGreaterThan(0.5);
  });

  it("handles empty strings", () => {
    expect(titleSimilarity("", "")).toBe(1);
    expect(titleSimilarity("test", "")).toBe(0);
    expect(titleSimilarity("", "test")).toBe(0);
  });
});

describe("computeSeverity", () => {
  it("returns high for removed requirements", () => {
    expect(computeSeverity("removed", 0, false, false)).toBe("high");
  });

  it("returns medium for large additions", () => {
    expect(computeSeverity("added", 600, false, false)).toBe("medium");
  });

  it("returns low for small additions", () => {
    expect(computeSeverity("added", 100, false, false)).toBe("low");
  });

  it("returns high for modified with priority change", () => {
    expect(computeSeverity("modified", 10, true, false)).toBe("high");
  });

  it("returns high for modified with type change", () => {
    expect(computeSeverity("modified", 10, false, true)).toBe("high");
  });

  it("returns medium for modified with large body delta", () => {
    expect(computeSeverity("modified", 400, false, false)).toBe("medium");
  });

  it("returns low for minor modifications", () => {
    expect(computeSeverity("modified", 10, false, false)).toBe("low");
  });
});

describe("computeImpactScore", () => {
  it("returns value between 0 and 1", () => {
    const score = computeImpactScore("added", "low", false, 10);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("returns higher for removals", () => {
    const removal = computeImpactScore("removed", "high", false, 100);
    const addition = computeImpactScore("added", "low", false, 100);
    expect(removal).toBeGreaterThan(addition);
  });

  it("increases for parent requirements (hierarchy impact)", () => {
    const withChildren = computeImpactScore("modified", "medium", true, 100);
    const withoutChildren = computeImpactScore("modified", "medium", false, 100);
    expect(withChildren).toBeGreaterThan(withoutChildren);
  });
});

describe("generateDiffSummary", () => {
  it("detects title changes", () => {
    const summary = generateDiffSummary(
      {
        id: "1",
        title: "Old Title",
        body: "body",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
      {
        id: "2",
        title: "New Title",
        body: "body",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
    );
    expect(summary).toContain("Title changed");
  });

  it("detects priority changes", () => {
    const summary = generateDiffSummary(
      {
        id: "1",
        title: "Title",
        body: "body",
        type: "feature",
        priority: "low",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
      {
        id: "2",
        title: "Title",
        body: "body",
        type: "feature",
        priority: "high",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
    );
    expect(summary).toContain("Priority changed from low to high");
  });

  it("reports no changes when identical", () => {
    const summary = generateDiffSummary(
      {
        id: "1",
        title: "Title",
        body: "body",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
      {
        id: "2",
        title: "Title",
        body: "body",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
    );
    expect(summary).toContain("No significant changes");
  });
});

describe("matchRequirements", () => {
  it("matches by title similarity", () => {
    const base = [
      {
        id: "b1",
        title: "User Authentication",
        body: "body",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
    ];
    const head = [
      {
        id: "h1",
        title: "User Authentication Module",
        body: "updated",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
    ];
    const result = matchRequirements(base, head);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0].base.id).toBe("b1");
    expect(result.matched[0].head.id).toBe("h1");
    expect(result.removed).toHaveLength(0);
    expect(result.added).toHaveLength(0);
  });

  it("detects removals and additions", () => {
    const base = [
      {
        id: "b1",
        title: "Feature A",
        body: "body",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
    ];
    const head = [
      {
        id: "h1",
        title: "Feature B",
        body: "body",
        type: "feature",
        priority: "medium",
        labels: "[]",
        storyPoints: null,
        parentId: null,
      },
    ];
    const result = matchRequirements(base, head);
    expect(result.matched).toHaveLength(0);
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].id).toBe("b1");
    expect(result.added).toHaveLength(1);
    expect(result.added[0].id).toBe("h1");
  });

  it("handles empty arrays", () => {
    const result = matchRequirements([], []);
    expect(result.matched).toHaveLength(0);
    expect(result.removed).toHaveLength(0);
    expect(result.added).toHaveLength(0);
  });
});

// ---- Service tests (with mocked Prisma) ------------------------------------

describe("triggerChangeAnalysis", () => {
  it("rejects if base analysis not found", async () => {
    await expect(
      triggerChangeAnalysis({
        projectId: "proj_1",
        baseAnalysisId: "missing",
        headAnalysisId: "head_1",
        actorId: "user_1",
      }),
    ).rejects.toThrow(ChangeAnalysisError);
  });

  it("rejects if base not completed", async () => {
    analyses.set("a1", { id: "a1", projectId: "proj_1", status: "running", deletedAt: null });
    analyses.set("a2", { id: "a2", projectId: "proj_1", status: "completed", deletedAt: null });

    await expect(
      triggerChangeAnalysis({
        projectId: "proj_1",
        baseAnalysisId: "a1",
        headAnalysisId: "a2",
        actorId: "user_1",
      }),
    ).rejects.toThrow("Base analysis must be completed");
  });

  it("rejects same analysis for base and head", async () => {
    analyses.set("a1", { id: "a1", projectId: "proj_1", status: "completed", deletedAt: null });

    await expect(
      triggerChangeAnalysis({
        projectId: "proj_1",
        baseAnalysisId: "a1",
        headAnalysisId: "a1",
        actorId: "user_1",
      }),
    ).rejects.toThrow("Base and head analysis cannot be the same");
  });

  it("creates a change analysis and detects additions", async () => {
    analyses.set("a1", { id: "a1", projectId: "proj_1", status: "completed", deletedAt: null });
    analyses.set("a2", { id: "a2", projectId: "proj_1", status: "completed", deletedAt: null });

    // Base has one requirement, head has two
    requirements.set("r1", {
      id: "r1",
      title: "Auth module",
      body: "Build auth",
      type: "feature",
      priority: "medium",
      labels: "[]",
      storyPoints: null,
      parentId: null,
      analysisId: "a1",
      projectId: "proj_1",
      deletedAt: null,
    });
    requirements.set("r2", {
      id: "r2",
      title: "Auth module",
      body: "Build auth",
      type: "feature",
      priority: "medium",
      labels: "[]",
      storyPoints: null,
      parentId: null,
      analysisId: "a2",
      projectId: "proj_1",
      deletedAt: null,
    });
    requirements.set("r3", {
      id: "r3",
      title: "New Dashboard",
      body: "Build dashboard",
      type: "feature",
      priority: "high",
      labels: "[]",
      storyPoints: 5,
      parentId: null,
      analysisId: "a2",
      projectId: "proj_1",
      deletedAt: null,
    });

    const result = await triggerChangeAnalysis({
      projectId: "proj_1",
      baseAnalysisId: "a1",
      headAnalysisId: "a2",
      actorId: "user_1",
    });

    expect(result.id).toBeDefined();
    expect(result.status).toBe("pending");

    // Wait for async execution
    await new Promise((r) => setTimeout(r, 100));

    const updated = changeAnalyses.get(result.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.additions).toBe(1);
    expect(updated?.removals).toBe(0);
  });

  it("detects modifications when body changes", async () => {
    analyses.set("a1", { id: "a1", projectId: "proj_1", status: "completed", deletedAt: null });
    analyses.set("a2", { id: "a2", projectId: "proj_1", status: "completed", deletedAt: null });

    requirements.set("r1", {
      id: "r1",
      title: "Auth module",
      body: "Original description",
      type: "feature",
      priority: "medium",
      labels: "[]",
      storyPoints: null,
      parentId: null,
      analysisId: "a1",
      projectId: "proj_1",
      deletedAt: null,
    });
    requirements.set("r2", {
      id: "r2",
      title: "Auth module",
      body: "Updated description with more detail",
      type: "feature",
      priority: "high",
      labels: "[]",
      storyPoints: null,
      parentId: null,
      analysisId: "a2",
      projectId: "proj_1",
      deletedAt: null,
    });

    const result = await triggerChangeAnalysis({
      projectId: "proj_1",
      baseAnalysisId: "a1",
      headAnalysisId: "a2",
      actorId: "user_1",
    });

    await new Promise((r) => setTimeout(r, 100));

    const updated = changeAnalyses.get(result.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.modifications).toBe(1);
  });
});

describe("listChangeAnalyses", () => {
  it("returns change analyses for a project", async () => {
    changeAnalyses.set("ca1", {
      id: "ca1",
      projectId: "proj_1",
      baseAnalysisId: "a1",
      headAnalysisId: "a2",
      status: "completed",
      summary: "test",
      totalChanges: 3,
      additions: 1,
      removals: 1,
      modifications: 1,
      startedById: "user_1",
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const result = await listChangeAnalyses("proj_1");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ca1");
  });
});

/**
 * Issue #1073 — the tenant scope has to live in the Prisma `where`, so these
 * exercise the service directly rather than only through the router.
 */
function seedAnalysisWithChange(): void {
  changeAnalyses.set("ca1", {
    id: "ca1",
    projectId: "proj_1",
    baseAnalysisId: "a1",
    headAnalysisId: "a2",
    status: "completed",
    summary: "1 change",
    totalChanges: 1,
    additions: 1,
    removals: 0,
    modifications: 0,
    startedById: "user_1",
    startedAt: new Date(),
    completedAt: new Date(),
    errorMessage: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  changes.set("rc1", {
    id: "rc1",
    changeAnalysisId: "ca1",
    changeType: "added",
    severity: "medium",
    impactScore: 0.5,
    requirementId: "r1",
    previousRequirementId: null,
    title: "Test",
    previousTitle: null,
    body: "body",
    previousBody: null,
    diffSummary: null,
    reviewStatus: "pending",
    reviewedById: null,
    reviewedAt: null,
    createdAt: new Date(),
  });
}

describe("getChangeAnalysis", () => {
  it("returns the detail when the analysis belongs to the project", async () => {
    seedAnalysisWithChange();

    const detail = await getChangeAnalysis({ id: "ca1", projectId: "proj_1" });

    expect(detail.id).toBe("ca1");
    expect(detail.changes).toHaveLength(1);
  });

  it("404s an analysis owned by another project", async () => {
    seedAnalysisWithChange();

    await expect(getChangeAnalysis({ id: "ca1", projectId: "proj_other" })).rejects.toMatchObject({
      status: 404,
      code: "CHANGE_ANALYSIS_NOT_FOUND",
    });
  });

  it("404s an unknown id the same way", async () => {
    await expect(getChangeAnalysis({ id: "missing", projectId: "proj_1" })).rejects.toMatchObject({
      status: 404,
      code: "CHANGE_ANALYSIS_NOT_FOUND",
    });
  });
});

describe("reviewChange", () => {
  it("approves a change", async () => {
    changeAnalyses.set("ca1", {
      id: "ca1",
      projectId: "proj_1",
      baseAnalysisId: "a1",
      headAnalysisId: "a2",
      status: "completed",
      summary: null,
      totalChanges: 1,
      additions: 1,
      removals: 0,
      modifications: 0,
      startedById: "user_1",
      startedAt: new Date(),
      completedAt: new Date(),
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    changes.set("rc1", {
      id: "rc1",
      changeAnalysisId: "ca1",
      changeType: "added",
      severity: "medium",
      impactScore: 0.5,
      requirementId: "r1",
      previousRequirementId: null,
      title: "Test",
      previousTitle: null,
      body: "body",
      previousBody: null,
      diffSummary: null,
      reviewStatus: "pending",
      reviewedById: null,
      reviewedAt: null,
      createdAt: new Date(),
    });

    const result = await reviewChange({
      projectId: "proj_1",
      changeAnalysisId: "ca1",
      changeId: "rc1",
      reviewStatus: "approved",
      actorId: "user_1",
    });

    expect(result.reviewStatus).toBe("approved");
  });

  it("rejects if change not found", async () => {
    await expect(
      reviewChange({
        projectId: "proj_1",
        changeAnalysisId: "ca1",
        changeId: "missing",
        reviewStatus: "approved",
        actorId: "user_1",
      }),
    ).rejects.toThrow(ChangeAnalysisError);
  });

  it("rejects a change that belongs to a different analysis", async () => {
    seedAnalysisWithChange();

    await expect(
      reviewChange({
        projectId: "proj_1",
        changeAnalysisId: "ca_other",
        changeId: "rc1",
        reviewStatus: "approved",
        actorId: "user_1",
      }),
    ).rejects.toMatchObject({ status: 404, code: "CHANGE_NOT_FOUND" });
  });

  it("rejects a change whose analysis belongs to a different project", async () => {
    seedAnalysisWithChange();

    await expect(
      reviewChange({
        projectId: "proj_other",
        changeAnalysisId: "ca1",
        changeId: "rc1",
        reviewStatus: "approved",
        actorId: "user_1",
      }),
    ).rejects.toMatchObject({ status: 404, code: "CHANGE_NOT_FOUND" });
  });
});
