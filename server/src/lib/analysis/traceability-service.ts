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
 *   3. a best-effort code-graph test-detection pass: for the code-graph symbols
 *      the requirements' code citations reference, find symbols in test-path
 *      files that have an edge pointing at them.
 *
 * The test column is explicitly heuristic (`testsDetection: "heuristic"`): analysis
 * code citations only carry a `symbolId` when the code agent resolved one, so a
 * requirement with no resolved symbol simply detects no tests — rendered as
 * "none detected", never fabricated.
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
import {
  buildTraceabilityMatrix,
  isTestFilePath,
  type MatrixFindingInput,
  type MatrixRequirementInput,
} from "./traceability-matrix.js";

type TraceabilityPrisma = Pick<PrismaClient, "requirementCodeMapping" | "codeEdge">;

export interface TraceabilityDeps {
  prisma?: TraceabilityPrisma;
  /** Injectable snapshot loader (tests). Defaults to the shared read path. */
  loadSnapshot?: typeof getAnalysisSnapshot;
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

  // (3) Best-effort code-graph test detection. Collect every code-graph symbol
  // id referenced by a requirement's code citations / mapping rows, then find
  // symbols in test-path files that have an edge INTO them.
  const symbolIds = new Set<string>();
  for (const finding of findingsById.values()) {
    for (const citation of finding.citations) {
      const symbolId = (citation as { symbolId?: string }).symbolId;
      if (symbolId) symbolIds.add(symbolId);
    }
  }
  for (const locs of deterministicByRequirement.values()) {
    for (const loc of locs) if (loc.symbolId) symbolIds.add(loc.symbolId);
  }

  const testsBySymbolId = await detectTestsForSymbols(prisma, snapshot.projectId, [...symbolIds]);

  return buildTraceabilityMatrix({
    analysisId: snapshot.id,
    projectId: snapshot.projectId,
    requirements,
    findingsById,
    deterministicByRequirement,
    testsBySymbolId,
  });
}

/**
 * For each target symbol id, find the symbols in TEST-path files that reference
 * it (an incoming `calls`/`references`/`imports` edge). Returns a map keyed by
 * the referenced (target) symbol id. Empty when there are no symbol ids or no
 * code graph — the matrix then renders every tests cell as "none detected".
 *
 * Query is scoped to the analysis project (defense-in-depth): `CodeEdge` carries
 * a denormalized `projectId`, so a stray symbol id cannot pull another project's
 * edges into this matrix.
 */
async function detectTestsForSymbols(
  prisma: TraceabilityPrisma,
  projectId: string,
  symbolIds: string[],
): Promise<Map<string, TraceabilityTestLink[]>> {
  const byTargetSymbol = new Map<string, TraceabilityTestLink[]>();
  if (symbolIds.length === 0) return byTargetSymbol;

  const edges = await prisma.codeEdge.findMany({
    where: {
      projectId,
      toSymbolId: { in: symbolIds },
      kind: { in: ["calls", "references", "imports"] },
    },
    select: {
      toSymbolId: true,
      fromSymbol: { select: { filePath: true, qualifiedName: true } },
    },
  });

  for (const edge of edges) {
    if (!edge.toSymbolId || !edge.fromSymbol) continue;
    if (!isTestFilePath(edge.fromSymbol.filePath)) continue;
    const list = byTargetSymbol.get(edge.toSymbolId) ?? [];
    // Dedupe identical (filePath, symbol) references to the same target.
    const key = `${edge.fromSymbol.filePath}::${edge.fromSymbol.qualifiedName}`;
    if (!list.some((t) => `${t.filePath}::${t.symbol}` === key)) {
      list.push({ filePath: edge.fromSymbol.filePath, symbol: edge.fromSymbol.qualifiedName });
    }
    byTargetSymbol.set(edge.toSymbolId, list);
  }

  return byTargetSymbol;
}
