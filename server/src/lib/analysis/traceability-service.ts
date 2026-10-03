/**
 * Traceability matrix service (Issue #737, Epic #726).
 *
 * Assembles the requirement→findings→code→tests matrix for one analysis from
 * ALREADY-PERSISTED data and hands it to the pure {@link buildTraceabilityMatrix}
 * builder. Three reads, no recomputation:
 *   1. the analysis snapshot — requirements (+ coverage + evidenceFindingIds) and
 *      every finding (+ code citations), via the existing `getAnalysisSnapshot`
 *      read path (so this stays consistent with the GET /analyses/:id contract);
 *   2. the requirement→code spine (`RequirementCodeMapping`) for deterministic-
 *      mapping provenance — additive, usually empty for a fresh analysis;
 *   3. the requirements' tests from the "Tested by" resolver (#814), so the
 *      matrix, the per-requirement chain and the test-gap list never disagree
 *      (#815). The resolver works from the requirement's mapped code (direct
 *      and via specs), not from analysis citations.
 *
 * The test column stays labelled heuristic (`testsDetection: "heuristic"`): the
 * resolver links tests by code-graph edges and naming conventions, so a
 * requirement with no resolved test renders "none detected", never fabricated.
 */
import type { PrismaClient } from "@prisma/client";
import {
  type FindingSeverity,
  type TraceabilityCodeLocation,
  type TraceabilityMatrix,
  type TraceabilityTestLink,
  FINDING_SEVERITIES,
} from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";
import { getAnalysisSnapshot } from "./analysis-service.js";
import { resolveTestedBy, type TestedByPrisma } from "../traceability/tested-by.js";
import {
  buildTraceabilityMatrix,
  type MatrixFindingInput,
  type MatrixRequirementInput,
} from "./traceability-matrix.js";

/** The spine read plus everything the "Tested by" resolver queries. */
type TraceabilityPrisma = Pick<PrismaClient, "requirementCodeMapping"> & TestedByPrisma;

export interface TraceabilityDeps {
  prisma?: TraceabilityPrisma;
  /** Injectable snapshot loader (tests). Defaults to the shared read path. */
  loadSnapshot?: typeof getAnalysisSnapshot;
  /** Injectable "Tested by" resolver (tests). Defaults to `resolveTestedBy` (#814). */
  resolveTests?: typeof resolveTestedBy;
}

const SEVERITY_SET = new Set<string>(FINDING_SEVERITIES);

function coerceSeverity(value: string): FindingSeverity {
  return SEVERITY_SET.has(value) ? (value as FindingSeverity) : "info";
}

/**
 * Build the traceability matrix for an analysis, or `null` when the analysis
 * does not exist / is not visible (the route maps that to 404 — no leak of
 * existence). Scope/ownership is enforced by the caller before this runs.
 */
export async function getTraceabilityMatrix(
  analysisId: string,
  deps: TraceabilityDeps = {},
): Promise<TraceabilityMatrix | null> {
  const prisma = (deps.prisma ??
    (defaultPrisma as unknown as TraceabilityPrisma)) as TraceabilityPrisma;
  const loadSnapshot = deps.loadSnapshot ?? getAnalysisSnapshot;
  const resolveTests = deps.resolveTests ?? resolveTestedBy;

  const snapshot = await loadSnapshot(analysisId);
  if (!snapshot) return null;

  // (1) Project the snapshot into the builder's minimal inputs.
  const requirements: MatrixRequirementInput[] = snapshot.requirements.map((r) => ({
    id: r.id,
    title: r.title,
    coverage: r.coverage ?? null,
    // Issue #773 — the three-state verdict rides the matrix so a `no_evidence`
    // coverage cell is never silently read as a confirmed gap.
    verdict: r.verdict ?? null,
    evidenceFindingIds: r.evidenceFindingIds,
  }));

  const findingsById = new Map<string, MatrixFindingInput>();
  for (const agent of snapshot.agents) {
    for (const finding of agent.findings) {
      findingsById.set(finding.id, {
        id: finding.id,
        title: finding.title,
        severity: coerceSeverity(finding.severity),
        citations: finding.citations,
      });
    }
  }

  // (2) Deterministic-mapping spine (additive; usually empty for a fresh run).
  const requirementIds = requirements.map((r) => r.id);
  const deterministicByRequirement = new Map<string, TraceabilityCodeLocation[]>();
  if (requirementIds.length > 0) {
    const mappingRows = await prisma.requirementCodeMapping.findMany({
      where: { requirementId: { in: requirementIds }, projectId: snapshot.projectId },
      select: {
        requirementId: true,
        codeSymbolId: true,
        filePath: true,
        startLine: true,
        endLine: true,
      },
      orderBy: [{ confidence: "desc" }],
    });
    for (const row of mappingRows) {
      const list = deterministicByRequirement.get(row.requirementId) ?? [];
      list.push({
        filePath: row.filePath,
        startLine: row.startLine,
        endLine: row.endLine,
        source: "deterministic-mapping",
        ...(row.codeSymbolId ? { symbolId: row.codeSymbolId } : {}),
      });
      deterministicByRequirement.set(row.requirementId, list);
    }
  }

  // (3) "Tested by" (#815): the same resolver, limit and order as the chain.
  const resolved = await resolveTests(snapshot.projectId, requirementIds, undefined, { prisma });
  const testsByRequirement = new Map<string, TraceabilityTestLink[]>();
  for (const [requirementId, tests] of resolved) {
    testsByRequirement.set(
      requirementId,
      tests.map((t) => ({ filePath: t.filePath, symbol: t.symbol, relation: t.relation })),
    );
  }

  return buildTraceabilityMatrix({
    analysisId: snapshot.id,
    projectId: snapshot.projectId,
    requirements,
    findingsById,
    deterministicByRequirement,
    testsByRequirement,
  });
}
