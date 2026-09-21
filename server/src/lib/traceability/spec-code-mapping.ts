/**
 * Spec ↔ Code traceability service — Epic #207 (#227).
 *
 * CRUD for `SpecCodeMapping` rows linking a "spec" (a `GeneratedDocument`) to a
 * concrete code location (`CodeSymbol` + file/line span). This mirrors
 * `RequirementCodeMapping` (`requirement-code-mapping.ts`) field-for-field and
 * completes the spec→code half of the requirement→spec→code spine.
 *
 * Referential scoping:
 *   - the spec document must exist, belong to `projectId`, and not be soft-deleted;
 *   - `codeSymbolId` is nullable (unresolved/external matches record a file-path
 *     hit only); when supplied it must belong to `projectId`.
 *
 * `persistDerived` is the idempotent entry point used by the backfill (#228):
 * it replaces the prior `derived` rows for a spec with the supplied matches,
 * never touching `manual` rows.
 *
 * Prisma is dependency-injected so unit tests can supply a fake client.
 */
import type {
  CreateSpecCodeMappingInput,
  SpecCodeMappingDetail,
  SpecMappingSource,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";

export interface SpecCodeMappingDeps {
  prisma?: Pick<
    PrismaClient,
    "specCodeMapping" | "generatedDocument" | "codeSymbol" | "$transaction"
  >;
}

function pickPrisma(deps?: SpecCodeMappingDeps) {
  const p = (deps?.prisma ?? defaultPrisma) as PrismaClient;
  return {
    client: p,
    mapping: p.specCodeMapping,
    spec: p.generatedDocument,
    codeSymbol: p.codeSymbol,
  };
}

interface MappingRow {
  id: string;
  specDocumentId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  source: string;
  createdAt: Date;
}

function toApi(row: MappingRow): SpecCodeMappingDetail {
  return {
    id: row.id,
    specDocumentId: row.specDocumentId,
    projectId: row.projectId,
    codeSymbolId: row.codeSymbolId,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    confidence: row.confidence,
    source: row.source as SpecMappingSource,
    createdAt: row.createdAt.toISOString(),
  };
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

async function assertCodeSymbolInProject(
  codeSymbol: Pick<PrismaClient["codeSymbol"], "findFirst">,
  projectId: string,
  codeSymbolId: string,
): Promise<void> {
  const row = await codeSymbol.findFirst({
    where: { id: codeSymbolId, projectId },
    select: { id: true },
  });
  if (!row) {
    throw new AppError(404, "CODE_SYMBOL_NOT_FOUND", "code symbol not found in this project");
  }
}

/** List the code links for a single spec (scoped to the project). */
export async function listForSpec(
  projectId: string,
  specDocumentId: string,
  deps?: SpecCodeMappingDeps,
): Promise<SpecCodeMappingDetail[]> {
  const { mapping, spec } = pickPrisma(deps);
  await assertSpecInProject(spec, projectId, specDocumentId);
  const rows = (await mapping.findMany({
    where: { specDocumentId },
    orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
  })) as MappingRow[];
  return rows.map(toApi);
}

/** List every spec→code link in the project. */
export async function listForProject(
  projectId: string,
  deps?: SpecCodeMappingDeps,
): Promise<SpecCodeMappingDetail[]> {
  const { mapping } = pickPrisma(deps);
  const rows = (await mapping.findMany({
    where: { projectId },
    orderBy: [{ createdAt: "desc" }],
  })) as MappingRow[];
  return rows.map(toApi);
}

/**
 * Create a spec→code link after validating the spec (and the symbol, when
 * supplied) belong to the project. Defaults `source` to "manual".
 */
export async function create(
  projectId: string,
  specDocumentId: string,
  input: CreateSpecCodeMappingInput,
  deps?: SpecCodeMappingDeps,
): Promise<SpecCodeMappingDetail> {
  const { mapping, spec, codeSymbol } = pickPrisma(deps);
  await assertSpecInProject(spec, projectId, specDocumentId);
  const codeSymbolId = input.codeSymbolId ?? null;
  if (codeSymbolId) {
    await assertCodeSymbolInProject(codeSymbol, projectId, codeSymbolId);
  }
  const row = (await mapping.create({
    data: {
      specDocumentId,
      projectId,
      codeSymbolId,
      filePath: input.filePath,
      startLine: input.startLine ?? null,
      endLine: input.endLine ?? null,
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      source: input.source ?? "manual",
    },
  })) as MappingRow;
  return toApi(row);
}

/** Delete a spec→code link after confirming it belongs to the named spec. */
export async function remove(
  projectId: string,
  specDocumentId: string,
  mappingId: string,
  deps?: SpecCodeMappingDeps,
): Promise<void> {
  const { mapping, spec } = pickPrisma(deps);
  await assertSpecInProject(spec, projectId, specDocumentId);
  const row = (await mapping.findFirst({
    where: { id: mappingId, specDocumentId },
    select: { id: true },
  })) as { id: string } | null;
  if (!row) {
    throw new AppError(404, "SPEC_CODE_MAPPING_NOT_FOUND", "spec→code mapping not found");
  }
  await mapping.delete({ where: { id: mappingId } });
}

/** A single derived spec→code match (pre-persistence shape). */
export interface SpecCodeMatch {
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
}

/**
 * Idempotently persist a spec's `derived` code links: drop the prior derived
 * rows for the spec, then insert the supplied matches. `manual` rows are never
 * touched. Used by the backfill (#228). Runs inside `$transaction` when the
 * injected client provides one (default singleton always does).
 */
export async function persistDerived(
  projectId: string,
  specDocumentId: string,
  matches: SpecCodeMatch[],
  deps?: SpecCodeMappingDeps,
): Promise<void> {
  const { client, mapping } = pickPrisma(deps);
  const ops = [
    mapping.deleteMany({ where: { specDocumentId, source: "derived" } }),
    mapping.createMany({
      data: matches.map((m) => ({
        specDocumentId,
        projectId,
        codeSymbolId: m.codeSymbolId,
        filePath: m.filePath,
        startLine: m.startLine,
        endLine: m.endLine,
        confidence: m.confidence,
        source: "derived",
      })),
    }),
  ];
  if (typeof client.$transaction === "function") {
    await client.$transaction(ops);
  } else {
    await ops[0];
    await ops[1];
  }
}
