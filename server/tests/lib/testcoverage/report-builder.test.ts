/**
 * Unit tests for `buildCoverageReport` (Epic #856 Phase 4 — issue #865).
 */
import { describe, it, expect, vi } from "vitest";

import { buildCoverageReport } from "../../../src/lib/testcoverage/report-builder.js";

function makePrisma(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    testCoverageRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: "run-1",
        projectId: "proj-1",
        project: { name: "Demo" },
      }),
    },
    coverageMapping: {
      findMany: vi.fn().mockResolvedValue([
        { requirementId: "r1", testCaseDocId: "t1", fused: 0.9, status: "COVERED" },
        { requirementId: "r1", testCaseDocId: "t2", fused: 0.6, status: "AMBIGUOUS" },
        { requirementId: "r2", testCaseDocId: "t1", fused: 0.2, status: "UNCOVERED" },
      ]),
    },
    gapItem: {
      findMany: vi.fn().mockResolvedValue([
        {
          requirementId: "r2",
          severity: "high",
          requirement: { id: "r2", title: "Reset password" },
        },
        { requirementId: "r3", severity: "bogus", requirement: null },
      ]),
    },
    suggestion: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: "s1",
          title: "Reset password happy path",
          gwtJson: JSON.stringify({ given: ["g"], when: ["w"], then: ["t"] }),
          stepsJson: JSON.stringify([{ action: "click", expected: "ok" }]),
          mappedRequirementIds: JSON.stringify(["r2"]),
          faithfulness: 0.85,
          lowConfidence: false,
        },
        {
          id: "s2",
          title: "Broken JSON suggestion",
          gwtJson: "not-json",
          stepsJson: "not-json",
          mappedRequirementIds: "not-json",
          faithfulness: 0.4,
          lowConfidence: true,
        },
      ]),
    },
    testCaseDoc: {
      findMany: vi.fn().mockResolvedValue([
        { id: "t1", title: "Login test" },
        { id: "t2", title: "Logout test" },
      ]),
    },
    requirement: {
      findMany: vi.fn().mockResolvedValue([
        { id: "r1", title: "Login" },
        { id: "r2", title: "Reset password" },
      ]),
    },
    ...overrides,
  };
}

describe("buildCoverageReport", () => {
  it("returns null when the run does not belong to the project", async () => {
    const prisma = makePrisma({
      testCoverageRun: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    const report = await buildCoverageReport({
      prisma: prisma as never,
      runId: "missing",
      projectId: "proj-1",
    });
    expect(report).toBeNull();
  });

  it("assembles requirements with best-score-driven status", async () => {
    const prisma = makePrisma();
    const report = await buildCoverageReport({
      prisma: prisma as never,
      runId: "run-1",
      projectId: "proj-1",
    });
    expect(report).not.toBeNull();
    expect(report!.projectName).toBe("Demo");
    expect(report!.requirements).toHaveLength(2);
    const r1 = report!.requirements.find((r) => r.requirementId === "r1");
    const r2 = report!.requirements.find((r) => r.requirementId === "r2");
    expect(r1?.status).toBe("covered");
    expect(r1?.bestScore).toBe(0.9);
    expect(r2?.status).toBe("uncovered");
  });

  it("normalises gap severity and falls back when invalid", async () => {
    const prisma = makePrisma();
    const report = await buildCoverageReport({
      prisma: prisma as never,
      runId: "run-1",
      projectId: "proj-1",
    });
    const high = report!.gaps.find((g) => g.requirementId === "r2");
    const fallback = report!.gaps.find((g) => g.requirementId === "r3");
    expect(high?.severity).toBe("high");
    expect(fallback?.severity).toBe("medium");
    expect(fallback?.title).toBe("r3");
  });

  it("recovers from malformed JSON in suggestion fields", async () => {
    const prisma = makePrisma();
    const report = await buildCoverageReport({
      prisma: prisma as never,
      runId: "run-1",
      projectId: "proj-1",
    });
    const s2 = report!.suggestions.find((s) => s.id === "s2");
    expect(s2?.gwt).toEqual({ given: [], when: [], then: [] });
    expect(s2?.steps).toEqual([]);
    expect(s2?.mappedRequirementIds).toEqual([]);
  });

  it("emits matrix cells one-per-mapping", async () => {
    const prisma = makePrisma();
    const report = await buildCoverageReport({
      prisma: prisma as never,
      runId: "run-1",
      projectId: "proj-1",
    });
    expect(report!.matrix).toHaveLength(3);
    expect(report!.matrix[0]).toMatchObject({
      requirementId: "r1",
      testCaseId: "t1",
      score: 0.9,
      status: "covered",
    });
  });

  it("falls back to projectId when project.name is missing", async () => {
    const prisma = makePrisma({
      testCoverageRun: {
        findFirst: vi.fn().mockResolvedValue({
          id: "run-1",
          projectId: "proj-1",
          project: null,
        }),
      },
    });
    const report = await buildCoverageReport({
      prisma: prisma as never,
      runId: "run-1",
      projectId: "proj-1",
    });
    expect(report?.projectName).toBe("proj-1");
  });
});
