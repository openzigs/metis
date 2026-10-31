/**
 * Epic #1608 (#1621) — persist and read a portfolio assessment.
 *
 * An assessment over every product a caller can read can name thousands of
 * repos, and SQLite's driver adapter refuses a statement binding more than 999
 * values (#1112, #1346). So child rows are written in batches sized from each
 * table's column count, and the whole write is one batch transaction: the
 * assessment and every child row land together or not at all. The id is made
 * here so the children can name it without an interactive transaction.
 */
import { randomUUID } from "node:crypto";
import {
  PORTFOLIO_ASSESSMENT_SCOPES,
  PORTFOLIO_ASSESSMENT_STATUSES,
  PORTFOLIO_COVERAGES,
  PORTFOLIO_IMPACT_KINDS,
  REQUIREMENT_VERDICTS,
  portfolioAssessmentInputSchema,
  type PortfolioAssessment,
  type PortfolioAssessmentInput,
} from "@metis/shared";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

/** Bound values per statement kept under SQLite's 999, with room to spare. */
export const SQLITE_SAFE_BIND_VALUES = 900;

/** Columns of each child table; every one may be bound on insert. */
const PRODUCT_COLUMNS = 11;
const REPO_COLUMNS = 7;

/** Rows of a `columns`-wide table that fit in one statement. */
export function rowsPerInsert(columns: number): number {
  return Math.max(1, Math.floor(SQLITE_SAFE_BIND_VALUES / columns));
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Write an assessment, its product rows and its repo rows. Input is validated
 * against the `@metis/shared` schema (enums, lengths). Returns the new id.
 */
export async function createPortfolioAssessment(raw: PortfolioAssessmentInput): Promise<string> {
  const input = portfolioAssessmentInputSchema.parse(raw);
  const id = randomUUID();
  const productRows: Prisma.PortfolioAssessmentProductCreateManyInput[] = input.products.map(
    (p) => ({
      assessmentId: id,
      productId: p.productId,
      coverage: p.coverage,
      impactKind: p.impactKind,
      via: p.via,
      edgeIds: JSON.stringify(p.edgeIds),
      severity: p.severity,
      baSummary: p.baSummary,
      technicalDetail: JSON.stringify(p.technicalDetail),
    }),
  );
  const repoRows: Prisma.PortfolioAssessmentRepoCreateManyInput[] = input.repos.map((r) => ({
    assessmentId: id,
    productId: r.productId,
    repoConnectionId: r.repoConnectionId,
    verdict: r.verdict,
    citations: JSON.stringify(r.citations),
  }));
  await prisma.$transaction([
    prisma.portfolioAssessment.create({
      data: {
        id,
        statement: input.statement,
        sourceRequirementId: input.sourceRequirementId,
        sourceProjectId: input.sourceProjectId,
        scope: input.scope,
        productIds: JSON.stringify(input.productIds),
        status: input.status,
        portfolioVerdict: input.portfolioVerdict,
        summary: input.summary,
        costUsd: input.costUsd,
        createdById: input.createdById,
      },
    }),
    ...chunks(productRows, rowsPerInsert(PRODUCT_COLUMNS)).map((data) =>
      prisma.portfolioAssessmentProduct.createMany({ data }),
    ),
    ...chunks(repoRows, rowsPerInsert(REPO_COLUMNS)).map((data) =>
      prisma.portfolioAssessmentRepo.createMany({ data }),
    ),
  ]);
  return id;
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null, fallback: T): T;
function oneOf<T extends string>(
  allowed: readonly T[],
  value: string | null,
  fallback: null,
): T | null;
function oneOf<T extends string>(
  allowed: readonly T[],
  value: string | null,
  fallback: T | null,
): T | null {
  return value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** Read an assessment back with its product and repo rows, or null when there is none. */
export async function getPortfolioAssessment(id: string): Promise<PortfolioAssessment | null> {
  const row = await prisma.portfolioAssessment.findUnique({
    where: { id },
    include: {
      products: { orderBy: { productId: "asc" } },
      repos: { orderBy: [{ productId: "asc" }, { repoConnectionId: "asc" }] },
    },
  });
  if (!row) return null;
  return {
    id: row.id,
    statement: row.statement,
    sourceRequirementId: row.sourceRequirementId,
    sourceProjectId: row.sourceProjectId,
    scope: oneOf(PORTFOLIO_ASSESSMENT_SCOPES, row.scope, "product"),
    productIds: parseJson<string[]>(row.productIds, []),
    status: oneOf(PORTFOLIO_ASSESSMENT_STATUSES, row.status, "failed"),
    portfolioVerdict: oneOf(PORTFOLIO_COVERAGES, row.portfolioVerdict, null),
    summary: row.summary,
    costUsd: row.costUsd,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    products: row.products.map((p) => ({
      productId: p.productId,
      coverage: oneOf(PORTFOLIO_COVERAGES, p.coverage, "not-checked"),
      impactKind: oneOf(PORTFOLIO_IMPACT_KINDS, p.impactKind, "none"),
      via: p.via,
      edgeIds: parseJson<string[]>(p.edgeIds, []),
      severity: p.severity,
      baSummary: p.baSummary,
      technicalDetail: parseJson<Record<string, unknown>>(p.technicalDetail, {}),
    })),
    repos: row.repos.map((r) => ({
      productId: r.productId,
      repoConnectionId: r.repoConnectionId,
      verdict: oneOf(REQUIREMENT_VERDICTS, r.verdict, "could-not-verify"),
      citations: parseJson<unknown[]>(r.citations, []),
    })),
  };
}
