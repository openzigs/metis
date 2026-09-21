/**
 * Requirement ↔ Spec traceability service — Epic #207 (#226).
 *
 * CRUD for `RequirementSpecMapping` rows that link a `Requirement` to a "spec"
 * (the spec entity IS a `GeneratedDocument`). This is the requirement→spec half
 * of the traceability spine; the spec→code half lives in `spec-code-mapping.ts`
 * and the end-to-end query in `traceability-spine.ts`.
 *
 * Referential scoping (enforced here, mirroring `requirement-data-mapping.ts`):
 *   - the requirement must exist and belong to `projectId`;
 *   - the spec document must exist, belong to `projectId`, and not be soft-deleted;
 *   - duplicate (requirement, spec) links are rejected with a clean 409, backed
 *     by the DB unique index on (requirementId, specDocumentId).
 *
 * Prisma is dependency-injected so unit tests can supply a fake client; it
 * defaults to the shared singleton.
 */
import type {
  CreateRequirementSpecMappingInput,
  RequirementSpecMappingDetail,
  SpecMappingSource,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";

export interface RequirementSpecMappingDeps {
  prisma?: Pick<PrismaClient, "requirementSpecMapping" | "requirement" | "generatedDocument">;
}

function pickPrisma(deps?: RequirementSpecMappingDeps) {
  const p = (deps?.prisma ?? defaultPrisma) as PrismaClient;
  return {
    mapping: p.requirementSpecMapping,
    requirement: p.requirement,
    spec: p.generatedDocument,
  };
}

/** A row as returned by Prisma with the spec title joined in. */
interface MappingRow {
  id: string;
  requirementId: string;
  specDocumentId: string;
  projectId: string;
  confidence: number;
  source: string;
  createdAt: Date;
  specDocument?: { title: string } | null;
}

const INCLUDE_SPEC = { specDocument: { select: { title: true } } } as const;

function toApi(row: MappingRow): RequirementSpecMappingDetail {
  return {
    id: row.id,
    requirementId: row.requirementId,
    specDocumentId: row.specDocumentId,
    specTitle: row.specDocument?.title ?? null,
    projectId: row.projectId,
    confidence: row.confidence,
    source: row.source as SpecMappingSource,
    createdAt: row.createdAt.toISOString(),
  };
}

async function assertRequirementInProject(
  requirement: Pick<PrismaClient["requirement"], "findFirst">,
  projectId: string,
  requirementId: string,
): Promise<void> {
  const row = await requirement.findFirst({
    where: { id: requirementId, projectId, deletedAt: null },
    select: { id: true },
  });
  if (!row) {
    throw new AppError(404, "REQUIREMENT_NOT_FOUND", "requirement not found in this project");
  }
}

async function assertSpecInProject(
  spec: Pick<PrismaClient["generatedDocument"], "findFirst">,
  projectId: string,
  specDocumentId: string,
): Promise<void> {
  const row = await spec.findFirst({
    where: { id: specDocumentId, projectId, deletedAt: null },
    select: { id: true },
  });
  if (!row) {
    throw new AppError(404, "SPEC_NOT_FOUND", "spec document not found in this project");
  }
}

/** Prisma's unique-constraint violation code. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/** List the spec links for a single requirement (scoped to the project). */
export async function listForRequirement(
  projectId: string,
  requirementId: string,
  deps?: RequirementSpecMappingDeps,
): Promise<RequirementSpecMappingDetail[]> {
  const { mapping, requirement } = pickPrisma(deps);
  await assertRequirementInProject(requirement, projectId, requirementId);
  const rows = (await mapping.findMany({
    where: { requirementId },
    include: INCLUDE_SPEC,
    orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
  })) as MappingRow[];
  return rows.map(toApi);
}

/** List every requirement→spec link in the project. */
export async function listForProject(
  projectId: string,
  deps?: RequirementSpecMappingDeps,
): Promise<RequirementSpecMappingDetail[]> {
  const { mapping } = pickPrisma(deps);
  const rows = (await mapping.findMany({
    where: { projectId },
    include: INCLUDE_SPEC,
    orderBy: [{ createdAt: "desc" }],
  })) as MappingRow[];
  return rows.map(toApi);
}

/**
 * Create a requirement→spec link after validating both ends belong to the
 * project. Defaults `source` to "manual" for hand-curated links. Rejects
 * duplicates with a 409 (DB unique index backstops the race).
 */
export async function create(
  projectId: string,
  requirementId: string,
  input: CreateRequirementSpecMappingInput,
  deps?: RequirementSpecMappingDeps,
): Promise<RequirementSpecMappingDetail> {
  const { mapping, requirement, spec } = pickPrisma(deps);
  await assertRequirementInProject(requirement, projectId, requirementId);
  await assertSpecInProject(spec, projectId, input.specDocumentId);

  try {
    const row = (await mapping.create({
      data: {
        requirementId,
        specDocumentId: input.specDocumentId,
        projectId,
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        source: input.source ?? "manual",
      },
      include: INCLUDE_SPEC,
    })) as MappingRow;
    return toApi(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(409, "SPEC_MAPPING_EXISTS", "this requirement→spec link already exists");
    }
    throw err;
  }
}

/**
 * Delete a requirement→spec link. Verifies it belongs to the named requirement
 * before mutating (prevents cross-requirement / IDOR deletes).
 */
export async function remove(
  projectId: string,
  requirementId: string,
  mappingId: string,
  deps?: RequirementSpecMappingDeps,
): Promise<void> {
  const { mapping, requirement } = pickPrisma(deps);
  await assertRequirementInProject(requirement, projectId, requirementId);
  const row = (await mapping.findFirst({
    where: { id: mappingId, requirementId },
    select: { id: true },
  })) as { id: string } | null;
  if (!row) {
    throw new AppError(404, "SPEC_MAPPING_NOT_FOUND", "spec mapping not found");
  }
  await mapping.delete({ where: { id: mappingId } });
}
