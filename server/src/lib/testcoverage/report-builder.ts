/**
 * Coverage report assembly (Epic #856 Phase 4 — issue #865 + #868).
 *
 * Translates the persisted run state (`CoverageMapping`, `GapItem`,
 * `Suggestion`, `Requirement`, `TestCaseDoc`) into the in-memory
 * `CoverageReport` shape consumed by exporters and the UI matrix.
 *
 * Pure data assembly — no I/O beyond the supplied Prisma client. The shape
 * matches `CoverageReport` from `exporters/types.ts` so it round-trips
 * through `exportCoverageReportToExcel` without further translation.
 */
import type { PrismaClient } from "@prisma/client";

import type {
  CoverageReport,
  ExportableSuggestion,
  GapRow,
  MatrixCell,
  RequirementCoverage,
} from "./exporters/types.js";

type PriorityLevel = "low" | "medium" | "high" | "critical";

const VALID_PRIORITIES = new Set<PriorityLevel>(["low", "medium", "high", "critical"]);

function castPriority(raw: string | null | undefined): PriorityLevel {
  if (raw && VALID_PRIORITIES.has(raw as PriorityLevel)) return raw as PriorityLevel;
  return "medium";
}

function scoreStatus(score: number): "covered" | "partial" | "uncovered" {
  if (score >= 0.8) return "covered";
  if (score >= 0.5) return "partial";
  return "uncovered";
}

export interface BuildReportArgs {
  readonly prisma: PrismaClient;
  readonly runId: string;
  readonly projectId: string;
}

/**
 * Materialise a `CoverageReport` for a single test-coverage run. Returns
 * `null` when the run doesn't exist or doesn't belong to the project.
 */
export async function buildCoverageReport(args: BuildReportArgs): Promise<CoverageReport | null> {
  const { prisma, runId, projectId } = args;

  const run = await prisma.testCoverageRun.findFirst({
    where: { id: runId, projectId },
    include: { project: { select: { name: true } } },
  });
  if (!run) return null;

  const [mappings, gapRows, suggestions, testCases, requirements] = await Promise.all([
    prisma.coverageMapping.findMany({
      where: { runId },
      select: {
        requirementId: true,
        testCaseDocId: true,
        fused: true,
        status: true,
      },
    }),
    prisma.gapItem.findMany({
      where: { runId },
      include: { requirement: { select: { id: true, title: true } } },
    }),
    prisma.suggestion.findMany({ where: { runId } }),
    prisma.testCaseDoc.findMany({
      where: { projectId },
      select: { id: true, title: true },
    }),
    prisma.requirement.findMany({
      where: { projectId },
      select: { id: true, title: true },
    }),
  ]);

  // Best-score per requirement → requirement coverage row.
  const bestByReq = new Map<string, number>();
  for (const m of mappings) {
    const cur = bestByReq.get(m.requirementId) ?? 0;
    if (m.fused > cur) bestByReq.set(m.requirementId, m.fused);
  }

  const requirementRows: RequirementCoverage[] = requirements.map((r) => {
    const best = bestByReq.get(r.id) ?? 0;
    return {
      requirementId: r.id,
      title: r.title,
      status: scoreStatus(best),
      bestScore: best,
    };
  });

  const matrix: MatrixCell[] = mappings.map((m) => ({
    requirementId: m.requirementId,
    testCaseId: m.testCaseDocId,
    score: m.fused,
    status: scoreStatus(m.fused),
  }));

  const gaps: GapRow[] = gapRows.map((g) => ({
    requirementId: g.requirementId,
    title: g.requirement?.title ?? g.requirementId,
    severity: castPriority(g.severity),
  }));

  const exportableSuggestions: ExportableSuggestion[] = suggestions.map((s) => {
    const gwt = safeParse<{ given?: string[]; when?: string[]; then?: string[] }>(s.gwtJson) ?? {};
    const steps = safeParse<Array<{ action: string; expected?: string }>>(s.stepsJson) ?? [];
    const mappedRequirementIds = safeParse<string[]>(s.mappedRequirementIds) ?? [];
    return {
      id: s.id,
      title: s.title,
      gwt: {
        given: gwt.given ?? [],
        when: gwt.when ?? [],
        then: gwt.then ?? [],
      },
      steps,
      mappedRequirementIds,
      faithfulness: s.faithfulness,
      lowConfidence: s.lowConfidence,
    };
  });

  return {
    runId,
    projectName: run.project?.name ?? projectId,
    generatedAt: new Date().toISOString(),
    requirements: requirementRows,
    testCases: testCases.map((t) => ({ id: t.id, title: t.title })),
    matrix,
    gaps,
    suggestions: exportableSuggestions,
  };
}

function safeParse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
