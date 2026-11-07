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
import {
  groundedFiles,
  SIMILAR_REQUIREMENT_SOURCE,
  type CodeCitationFreshness,
  type CodeCitationStaleReason,
  type RequirementTraceabilityChain,
  type SpecMappingSource,
  type TraceabilityCodeNode,
  type TraceabilitySpecNode,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { classifyTestSymbol } from "../code-graph/test-conventions.js";
import { uniqueCodeLinks } from "./code-link-key.js";
import { resolveTestedByForTargets, type TestedByPrisma } from "./tested-by.js";
import { hideSupersededBorrowedLinks } from "./borrow-citations.js";

type SpinePrisma = Pick<
  PrismaClient,
  | "requirement"
  | "requirementSpecMapping"
  | "specCodeMapping"
  | "requirementCodeMapping"
  | "codeSymbol"
  | "codeEdge"
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
    source: row.source as TraceabilityCodeNode["source"],
    isTest: classifyTestSymbol({ filePath: row.filePath }).isTestFile,
  };
}

/**
 * #1830 — a direct requirement→code link, with the code-graph version it was
 * read from and whether it still holds.
 */
function toDirectCodeNode(
  row: Parameters<typeof toCodeNode>[0] & {
    freshness: string;
    commitSha: string | null;
    validatedAt: Date | null;
    staleReason: string | null;
    previousFilePath: string | null;
    previousStartLine: number | null;
    previousEndLine: number | null;
    originRequirementId: string | null;
  },
): TraceabilityCodeNode {
  return {
    ...toCodeNode(row),
    freshness: row.freshness as CodeCitationFreshness,
    commitSha: row.commitSha,
    validatedAt: row.validatedAt?.toISOString() ?? null,
    // #1831 — why a stale link no longer holds, and where a moved one was.
    staleReason: row.staleReason as CodeCitationStaleReason | null,
    previousFilePath: row.previousFilePath,
    previousStartLine: row.previousStartLine,
    previousEndLine: row.previousEndLine,
    // #1839 — where a borrowed (`similar-requirement`) link was copied from.
    originRequirementId: row.originRequirementId,
  };
}

/**
 * #1840 — how each borrowed link's origin requirement is named ("Borrowed from
 * REQ-12"): its key, else its title. Read within the project, so an origin id
 * of another project names nothing; a deleted origin names nothing either.
 */
async function borrowedOriginLabels(
  prisma: SpinePrisma,
  projectId: string,
  rows: ReadonlyArray<{ originRequirementId: string | null }>,
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.flatMap((r) => (r.originRequirementId ? [r.originRequirementId] : []))),
  ];
  if (ids.length === 0) return new Map();
  const origins = await prisma.requirement.findMany({
    where: { projectId, id: { in: ids }, deletedAt: null },
    select: { id: true, title: true, promotedStructuredId: true, externalId: true },
  });
  return new Map(origins.map((o) => [o.id, o.promotedStructuredId ?? o.externalId ?? o.title]));
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
    select: { id: true, title: true, body: true },
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

  const storedDirectRows = await prisma.requirementCodeMapping.findMany({
    where: { requirementId, projectId },
    select: {
      codeSymbolId: true,
      filePath: true,
      startLine: true,
      endLine: true,
      confidence: true,
      source: true,
      freshness: true,
      commitSha: true,
      validatedAt: true,
      staleReason: true,
      previousFilePath: true,
      previousStartLine: true,
      previousEndLine: true,
      originRequirementId: true,
    },
    orderBy: [{ confidence: "desc" }],
  });
  // #1839 — a link borrowed from a similar requirement gives way to this
  // requirement's own analysis grounding of the same file: never shown twice.
  // #1825 — then each (filePath, codeSymbolId) once: the code agent's citation and
  // the semantic mapper can both link a file. The surer row (read first) is kept.
  const directRows = uniqueCodeLinks(hideSupersededBorrowedLinks(storedDirectRows));
  const originLabels = await borrowedOriginLabels(prisma, projectId, directRows);

  // #814 — the tests that cover this requirement, resolved from the code rows
  // just read (the resolver issues only its code-graph queries). #1902 — not
  // from a borrowed link: its code node is labelled, a test it reached is not.
  // Filtered before the dedupe: a borrowed row can outrank this requirement's own
  // lower-confidence row on the same code, and filtering after would drop both.
  const ownRows = uniqueCodeLinks(
    storedDirectRows.filter((row) => row.source !== SIMILAR_REQUIREMENT_SOURCE),
  );
  const tested = await resolveTestedByForTargets(
    projectId,
    [requirement],
    new Map([[requirement.id, [...ownRows, ...specCodeRows]]]),
    undefined,
    { prisma: prisma as unknown as TestedByPrisma },
  );

  return {
    requirementId: requirement.id,
    requirementTitle: requirement.title,
    projectId,
    specs,
    // #1840 — only a borrowed link names its origin; every other node is unchanged.
    directCode: directRows.map((row) => ({
      ...toDirectCodeNode(row),
      ...(row.originRequirementId
        ? { originRequirementLabel: originLabels.get(row.originRequirementId) ?? null }
        : {}),
    })),
    testedBy: tested.get(requirement.id) ?? [],
    // #1969 — read from every stored row: the dedupe above can hide a grounding row.
    groundedFiles: [...groundedFiles(storedDirectRows)].sort(),
  };
}

/**
 * Reverse lookup: given a file path, return the ids of requirements that reach
 * that file either directly (requirement→code) or via a spec (spec→code →
 * requirement→spec). Deduplicated, scoped to the project.
 *
 * #1913 — a link borrowed from a similar requirement (#1839) is not read: the
 * answer is bare ids, so it cannot say "borrowed", and a suggestion no analysis
 * has checked is no evidence that the requirement implements the file.
 */
export async function getRequirementsForFile(
  projectId: string,
  filePath: string,
  deps?: TraceabilityDeps,
): Promise<string[]> {
  const prisma = pickPrisma(deps);
  const ids = new Set<string>();

  const direct = await prisma.requirementCodeMapping.findMany({
    where: { projectId, filePath, source: { not: SIMILAR_REQUIREMENT_SOURCE } },
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
