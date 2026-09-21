/**
 * Requirement ↔ data (table/column) traceability service — Epic #889 (#892).
 *
 * CRUD for `RequirementDataMapping` rows that link a `Requirement` to a table
 * (and optionally a column) exposed by one of the project's
 * `DatabaseConnection`s. Reuses the connector RBAC at the route layer; this
 * module enforces referential scoping so a mapping can never bridge two
 * projects or point at a requirement/connector the caller did not name:
 *
 *   - the requirement must exist and belong to `projectId`;
 *   - the connector must exist (not soft-deleted) and belong to `projectId`;
 *   - duplicate links are rejected with a clean 409 (DB unique guard for
 *     fully-specified tuples, plus an explicit service-layer check for
 *     table-level/null-column tuples, which SQLite/Postgres treat as distinct
 *     in unique indexes).
 *
 * Prisma is dependency-injected so unit tests can supply a fake client; it
 * defaults to the shared singleton.
 */
import type {
  CreateRequirementDataMappingInput,
  RequirementDataMappingDetail,
  RequirementDataMappingSource,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";

type MappingDelegate = PrismaClient["requirementDataMapping"];
type RequirementDelegate = Pick<PrismaClient["requirement"], "findFirst">;
type ConnectorDelegate = Pick<PrismaClient["databaseConnection"], "findFirst">;

export interface RequirementDataMappingDeps {
  prisma?: Pick<PrismaClient, "requirementDataMapping" | "requirement" | "databaseConnection">;
}

function pickPrisma(deps?: RequirementDataMappingDeps): {
  client: PrismaClient;
  mapping: MappingDelegate;
  requirement: RequirementDelegate;
  connector: ConnectorDelegate;
} {
  const p = (deps?.prisma ?? defaultPrisma) as PrismaClient;
  return {
    client: p,
    mapping: p.requirementDataMapping,
    requirement: p.requirement,
    connector: p.databaseConnection,
  };
}

// A row as returned by Prisma with the connector label joined in.
interface MappingRow {
  id: string;
  requirementId: string;
  dbConnectorId: string;
  schemaName: string | null;
  tableName: string;
  columnName: string | null;
  confidence: number;
  source: string;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  dbConnector?: { label: string } | null;
}

function toApi(row: MappingRow): RequirementDataMappingDetail {
  return {
    id: row.id,
    requirementId: row.requirementId,
    dbConnectorId: row.dbConnectorId,
    dbConnectorLabel: row.dbConnector?.label ?? null,
    schemaName: row.schemaName,
    tableName: row.tableName,
    columnName: row.columnName,
    confidence: row.confidence,
    source: row.source as RequirementDataMappingSource,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const INCLUDE_CONNECTOR = { dbConnector: { select: { label: true } } } as const;

async function assertRequirementInProject(
  requirement: RequirementDelegate,
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

async function assertConnectorInProject(
  connector: ConnectorDelegate,
  projectId: string,
  dbConnectorId: string,
): Promise<void> {
  const row = await connector.findFirst({
    where: { id: dbConnectorId, projectId, deletedAt: null },
    select: { id: true },
  });
  if (!row) {
    throw new AppError(
      404,
      "DB_CONNECTOR_NOT_FOUND",
      "database connector not found in this project",
    );
  }
}

/** Prisma's unique-constraint violation code. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";
}

/**
 * List the mappings for a single requirement (scoped to the project).
 * Soft-deleted rows are excluded.
 */
export async function listForRequirement(
  projectId: string,
  requirementId: string,
  deps?: RequirementDataMappingDeps,
): Promise<RequirementDataMappingDetail[]> {
  const { mapping, requirement } = pickPrisma(deps);
  await assertRequirementInProject(requirement, projectId, requirementId);
  const rows = (await mapping.findMany({
    where: { requirementId, deletedAt: null },
    include: INCLUDE_CONNECTOR,
    orderBy: [{ confidence: "desc" }, { createdAt: "asc" }],
  })) as MappingRow[];
  return rows.map(toApi);
}

/**
 * List every mapping in the project (across all requirements), joining the
 * connector label for display. Soft-deleted rows are excluded.
 */
export async function listForProject(
  projectId: string,
  deps?: RequirementDataMappingDeps,
): Promise<RequirementDataMappingDetail[]> {
  const { mapping } = pickPrisma(deps);
  const rows = (await mapping.findMany({
    where: { deletedAt: null, requirement: { projectId, deletedAt: null } },
    include: INCLUDE_CONNECTOR,
    orderBy: [{ createdAt: "desc" }],
  })) as MappingRow[];
  return rows.map(toApi);
}

/**
 * Create a mapping after validating the requirement + connector both belong to
 * the project. Rejects duplicates (including table-level/null-column tuples the
 * DB unique index would otherwise allow) with a 409.
 *
 * The dup-check + insert run inside an interactive transaction so the read and
 * the write are not interleaved by a concurrent request (the previous separate
 * awaits left a TOCTOU window for null-column tuples, which the DB unique index
 * treats as distinct and therefore cannot backstop). On the serialized-write
 * SQLite path this closes the race outright; on Postgres it narrows the window,
 * and the `P2002` catch still backstops fully-specified-tuple duplicates. The
 * transaction is optional so injected test fakes without `$transaction` keep
 * working unchanged.
 */
export async function create(
  projectId: string,
  requirementId: string,
  input: CreateRequirementDataMappingInput,
  deps?: RequirementDataMappingDeps,
): Promise<RequirementDataMappingDetail> {
  const { client, mapping, requirement, connector } = pickPrisma(deps);
  await assertRequirementInProject(requirement, projectId, requirementId);
  await assertConnectorInProject(connector, projectId, input.dbConnectorId);

  const schemaName = input.schemaName ?? null;
  const columnName = input.columnName ?? null;

  // Atomic dup-check + insert. `tx` is the transaction-scoped client when a
  // real `$transaction` is available, otherwise the caller-supplied delegate.
  const checkThenCreate = async (tx: {
    requirementDataMapping: Pick<MappingDelegate, "findFirst" | "create">;
  }): Promise<MappingRow> => {
    // Explicit dup guard: NULLs are distinct in unique indexes, so a table-level
    // (null column) duplicate would slip past the DB constraint.
    const existing = await tx.requirementDataMapping.findFirst({
      where: {
        requirementId,
        dbConnectorId: input.dbConnectorId,
        schemaName,
        tableName: input.tableName,
        columnName,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (existing) {
      throw new AppError(
        409,
        "DATA_MAPPING_EXISTS",
        "this requirement→data mapping already exists",
      );
    }
    return (await tx.requirementDataMapping.create({
      data: {
        requirementId,
        dbConnectorId: input.dbConnectorId,
        schemaName,
        tableName: input.tableName,
        columnName,
        ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
        ...(input.source ? { source: input.source } : {}),
        note: input.note ?? null,
      },
      include: INCLUDE_CONNECTOR,
    })) as MappingRow;
  };

  try {
    const row =
      typeof client.$transaction === "function"
        ? await client.$transaction((tx) => checkThenCreate(tx))
        : await checkThenCreate({ requirementDataMapping: mapping });
    return toApi(row);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        "DATA_MAPPING_EXISTS",
        "this requirement→data mapping already exists",
      );
    }
    throw err;
  }
}

/**
 * Soft-delete a mapping. Verifies the mapping belongs to the named requirement
 * and project before mutating (prevents cross-requirement/IDOR deletes).
 */
export async function remove(
  projectId: string,
  requirementId: string,
  mappingId: string,
  deps?: RequirementDataMappingDeps,
): Promise<void> {
  const { mapping, requirement } = pickPrisma(deps);
  await assertRequirementInProject(requirement, projectId, requirementId);
  const row = (await mapping.findFirst({
    where: { id: mappingId, requirementId, deletedAt: null },
    select: { id: true },
  })) as { id: string } | null;
  if (!row) {
    throw new AppError(404, "DATA_MAPPING_NOT_FOUND", "data mapping not found");
  }
  await mapping.update({ where: { id: mappingId }, data: { deletedAt: new Date() } });
}
