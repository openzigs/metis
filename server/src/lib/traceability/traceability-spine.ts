/**
 * Requirement → Spec → Code traceability query — Epic #207 (#229).
 *
 * Assembles the end-to-end chain for a single requirement by joining the three
 * mapping tables built in #226/#227 plus the pre-existing #159
 * `RequirementCodeMapping` spine:
 *
 *   Requirement
 *     ├─ specs[]  (RequirementSpecMapping → GeneratedDocument)
 *     │    └─ code[]  (SpecCodeMapping)
 *     └─ directCode[] (RequirementCodeMapping — the requirement→code spine)
 *
 * The reverse direction (`codeToRequirements`) answers "which requirements does
 * this file implement?" by walking spec→code and requirement→code back to the
 * requirements. Prisma is dependency-injected for unit testing.
 */
import type {
  RequirementTraceabilityChain,
  SpecMappingSource,
  TraceabilityCodeNode,
  TraceabilitySpecNode,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";

type SpinePrisma = Pick<
  PrismaClient,
  "requirement" | "requirementSpecMapping" | "specCodeMapping" | "requirementCodeMapping"
>;

export interface TraceabilityDeps {
  prisma?: SpinePrisma;
}

function pickPrisma(deps?: TraceabilityDeps): SpinePrisma {
  return (deps?.prisma ?? (defaultPrisma as unknown as SpinePrisma)) as SpinePrisma;
}

function toCodeNode(row: {
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  source: string;
}): TraceabilityCodeNode {
  return {
    codeSymbolId: row.codeSymbolId,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    confidence: row.confidence,
    source: row.source as SpecMappingSource,
  };
}

/**
 * Build the full requirement→spec→code chain for one requirement (scoped to the
 * project). Throws 404 if the requirement does not exist in the project.
 */
export async function getRequirementChain(
  projectId: string,
  requirementId: string,
  deps?: TraceabilityDeps,
): Promise<RequirementTraceabilityChain> {
  const prisma = pickPrisma(deps);

  const requirement = await prisma.requirement.findFirst({
    where: { id: requirementId, projectId, deletedAt: null },
    select: { id: true, title: true },
  });
  if (!requirement) {
    throw new AppError(404, "REQUIREMENT_NOT_FOUND", "requirement not found in this project");
  }

  const specLinks = await prisma.requirementSpecMapping.findMany({
    where: { requirementId, projectId },
    select: {
      specDocumentId: true,
      confidence: true,
      source: true,
      specDocument: { select: { title: true } },
    },
    orderBy: [{ confidence: "desc" }],
  });

  const specIds = specLinks.map((s) => s.specDocumentId);
  const specCodeRows = specIds.length
    ? await prisma.specCodeMapping.findMany({
        where: { specDocumentId: { in: specIds }, projectId },
        select: {
          specDocumentId: true,
          codeSymbolId: true,
          filePath: true,
          startLine: true,
          endLine: true,
          confidence: true,
          source: true,
        },
        orderBy: [{ confidence: "desc" }],
      })
    : [];

  const codeBySpec = new Map<string, TraceabilityCodeNode[]>();
  for (const row of specCodeRows) {
    const list = codeBySpec.get(row.specDocumentId) ?? [];
    list.push(toCodeNode(row));
    codeBySpec.set(row.specDocumentId, list);
  }

  const specs: TraceabilitySpecNode[] = specLinks.map((s) => ({
    specDocumentId: s.specDocumentId,
    specTitle: s.specDocument?.title ?? null,
    confidence: s.confidence,
    source: s.source as SpecMappingSource,
    code: codeBySpec.get(s.specDocumentId) ?? [],
  }));

  const directRows = await prisma.requirementCodeMapping.findMany({
    where: { requirementId, projectId },
    select: {
      codeSymbolId: true,
      filePath: true,
      startLine: true,
      endLine: true,
      confidence: true,
      source: true,
    },
    orderBy: [{ confidence: "desc" }],
  });

  return {
    requirementId: requirement.id,
    requirementTitle: requirement.title,
    projectId,
    specs,
    directCode: directRows.map(toCodeNode),
  };
}

/**
 * Reverse lookup: given a file path, return the ids of requirements that reach
 * that file either directly (requirement→code) or via a spec (spec→code →
 * requirement→spec). Deduplicated, scoped to the project.
 */
export async function getRequirementsForFile(
  projectId: string,
  filePath: string,
  deps?: TraceabilityDeps,
): Promise<string[]> {
  const prisma = pickPrisma(deps);
  const ids = new Set<string>();

  const direct = await prisma.requirementCodeMapping.findMany({
    where: { projectId, filePath },
    select: { requirementId: true },
  });
  for (const r of direct) ids.add(r.requirementId);

  const specCode = await prisma.specCodeMapping.findMany({
    where: { projectId, filePath },
    select: { specDocumentId: true },
  });
  const specIds = [...new Set(specCode.map((s) => s.specDocumentId))];
  if (specIds.length) {
    const reqSpec = await prisma.requirementSpecMapping.findMany({
      where: { projectId, specDocumentId: { in: specIds } },
      select: { requirementId: true },
    });
    for (const r of reqSpec) ids.add(r.requirementId);
  }

  return [...ids];
}
