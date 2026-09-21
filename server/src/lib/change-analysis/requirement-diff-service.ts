/**
 * Diff-style current-vs-proposed SERVICE (Issue #743, Epic #728).
 *
 * Assembles the {@link RequirementDiff} for a head analysis against a base run
 * from ALREADY-PERSISTED data and hands it to the pure {@link buildRequirementDiff}
 * aggregator — no recompute of requirement text, no LLM call. The requirement
 * diffing itself is delegated to the Change Analysis engine's exported primitives
 * inside the aggregator (see requirement-diff.ts); this service only loads the two
 * runs' requirements + their #742 gap reports and resolves the base run.
 *
 * Base resolution: an explicit `baseAnalysisId` wins; otherwise the project's most
 * recent completed run that started before the head run is used (the natural
 * "previous run" default). When no base can be resolved, the aggregator returns an
 * empty diff — the route surfaces that as an honest empty state, never a 404.
 *
 * Ownership: the ROUTE enforces that both head and (when supplied) base analyses
 * belong to the caller's project via `ensureAnalysisVisible` (OWASP A01 / BOLA).
 * This service trusts that guard and additionally scopes its base auto-resolution
 * query to the same project id, so it can never pull a cross-project run.
 */
import {
  REQUIREMENT_PRIORITIES,
  type GapReport,
  type RequirementDiff,
  type RequirementPriority,
} from "@metis/shared";
import { prisma } from "../prisma.js";
import { getGapReport } from "../analysis/gap-report-service.js";
import { buildRequirementDiff, type RequirementDiffRequirementInput } from "./requirement-diff.js";

const PRIORITY_SET = new Set<string>(REQUIREMENT_PRIORITIES);

function coercePriority(value: string): RequirementPriority {
  return PRIORITY_SET.has(value) ? (value as RequirementPriority) : "medium";
}

/** Lightweight analysis metadata needed to resolve + validate the base run. */
export interface RequirementDiffAnalysisMeta {
  id: string;
  status: string;
  startedAt: Date;
}

export interface RequirementDiffDeps {
  /** Load an analysis' metadata scoped to a project (null ⇒ not found / not visible). */
  loadAnalysisMeta?: (
    analysisId: string,
    projectId: string,
  ) => Promise<RequirementDiffAnalysisMeta | null>;
  /** Resolve the default base run: latest completed run before `before`, same project. */
  findPreviousAnalysisId?: (
    projectId: string,
    headAnalysisId: string,
    before: Date,
  ) => Promise<string | null>;
  /** Load a run's requirements in the shape the aggregator + engine matcher need. */
  loadRequirements?: (analysisId: string) => Promise<RequirementDiffRequirementInput[]>;
  /** Load a run's #742 gap report (injectable; defaults to the shared service). */
  loadGapReport?: (analysisId: string) => Promise<GapReport | null>;
}

async function defaultLoadAnalysisMeta(
  analysisId: string,
  projectId: string,
): Promise<RequirementDiffAnalysisMeta | null> {
  const row = await prisma.analysis.findFirst({
    where: { id: analysisId, projectId, deletedAt: null },
    select: { id: true, status: true, startedAt: true },
  });
  return row ? { id: row.id, status: row.status, startedAt: row.startedAt } : null;
}

async function defaultFindPreviousAnalysisId(
  projectId: string,
  headAnalysisId: string,
  before: Date,
): Promise<string | null> {
  const row = await prisma.analysis.findFirst({
    where: {
      projectId,
      deletedAt: null,
      status: "completed",
      id: { not: headAnalysisId },
      startedAt: { lt: before },
    },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });
  return row?.id ?? null;
}

async function defaultLoadRequirements(
  analysisId: string,
): Promise<RequirementDiffRequirementInput[]> {
  const rows = await prisma.requirement.findMany({
    where: { analysisId, deletedAt: null },
    select: {
      id: true,
      title: true,
      body: true,
      type: true,
      priority: true,
      labels: true,
      storyPoints: true,
      parentId: true,
    },
  });
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    type: r.type,
    priority: coercePriority(r.priority),
    labels: r.labels,
    storyPoints: r.storyPoints,
    parentId: r.parentId,
  }));
}

/**
 * Build the current-vs-proposed diff for `headAnalysisId` against a base run.
 *
 * Returns `null` when the head analysis does not exist / is not visible in the
 * project (the route maps that to 404 — no existence leak). When the head is
 * valid but no base run can be resolved, returns an EMPTY diff (baseAnalysisId
 * null) — a legitimate empty state, not an error.
 */
export async function getRequirementDiff(
  opts: {
    projectId: string;
    headAnalysisId: string;
    baseAnalysisId?: string | null;
  },
  deps: RequirementDiffDeps = {},
): Promise<RequirementDiff | null> {
  const loadAnalysisMeta = deps.loadAnalysisMeta ?? defaultLoadAnalysisMeta;
  const findPreviousAnalysisId = deps.findPreviousAnalysisId ?? defaultFindPreviousAnalysisId;
  const loadRequirements = deps.loadRequirements ?? defaultLoadRequirements;
  const loadGapReport = deps.loadGapReport ?? getGapReport;

  const head = await loadAnalysisMeta(opts.headAnalysisId, opts.projectId);
  if (!head) return null;

  // Resolve the base run: explicit id (validated to same project) wins; else the
  // previous completed run. Either can end up null ⇒ empty diff.
  let baseId: string | null = null;
  if (opts.baseAnalysisId) {
    const base = await loadAnalysisMeta(opts.baseAnalysisId, opts.projectId);
    // A supplied-but-invalid base (missing / cross-project / not completed / same
    // as head) is treated as "no comparison" rather than leaking which is why.
    if (base && base.status === "completed" && base.id !== head.id) {
      baseId = base.id;
    }
  } else {
    baseId = await findPreviousAnalysisId(opts.projectId, head.id, head.startedAt);
  }

  if (!baseId) {
    return buildRequirementDiff({
      projectId: opts.projectId,
      headAnalysisId: head.id,
      baseAnalysisId: null,
      base: null,
      head: { requirements: [], gapReport: null },
    });
  }

  const [headReqs, baseReqs, headGap, baseGap] = await Promise.all([
    loadRequirements(head.id),
    loadRequirements(baseId),
    loadGapReport(head.id),
    loadGapReport(baseId),
  ]);

  return buildRequirementDiff({
    projectId: opts.projectId,
    headAnalysisId: head.id,
    baseAnalysisId: baseId,
    base: { requirements: baseReqs, gapReport: baseGap },
    head: { requirements: headReqs, gapReport: headGap },
  });
}
