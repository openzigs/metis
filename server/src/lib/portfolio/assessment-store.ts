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
  portfolioReportSchema,
  type PortfolioAssessment,
  type PortfolioAssessmentInput,
} from "@metis/shared";
// `Prisma` from the client package, not ../prisma.js: the column counts below are
// read at import, and test files that mock ../prisma.js without `Prisma` load this
// module through the socket job-room scope (#1625).
import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

/** Bound values per statement kept under SQLite's 999, with room to spare. */
export const SQLITE_SAFE_BIND_VALUES = 900;

/**
 * Columns of each child table; every one may be bound on insert. Read from the
 * generated client's scalar-field enums (#1647), so a column added to the
 * schema shrinks the batch rather than pushing it past the bind limit.
 */
export const PRODUCT_COLUMNS = Object.keys(Prisma.PortfolioAssessmentProductScalarFieldEnum).length;
export const REPO_COLUMNS = Object.keys(Prisma.PortfolioAssessmentRepoScalarFieldEnum).length;

/** Rows of a `columns`-wide table that fit in one statement. */
export function rowsPerInsert(columns: number): number {
  return Math.max(1, Math.floor(SQLITE_SAFE_BIND_VALUES / columns));
}

function chunks<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/** The child rows of an assessment, each naming `assessmentId`. */
function childRows(
  assessmentId: string,
  input: ReturnType<typeof portfolioAssessmentInputSchema.parse>,
): Prisma.PrismaPromise<unknown>[] {
  const productRows: Prisma.PortfolioAssessmentProductCreateManyInput[] = input.products.map(
    (p) => ({
      assessmentId,
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
    assessmentId,
    productId: r.productId,
    repoConnectionId: r.repoConnectionId,
    verdict: r.verdict,
    citations: JSON.stringify(r.citations),
  }));
  return [
    ...chunks(productRows, rowsPerInsert(PRODUCT_COLUMNS)).map((data) =>
      prisma.portfolioAssessmentProduct.createMany({ data }),
    ),
    ...chunks(repoRows, rowsPerInsert(REPO_COLUMNS)).map((data) =>
      prisma.portfolioAssessmentRepo.createMany({ data }),
    ),
  ];
}

/**
 * Write an assessment, its product rows and its repo rows. Input is validated
 * against the `@metis/shared` schema (enums, lengths). Returns the new id.
 */
export async function createPortfolioAssessment(raw: PortfolioAssessmentInput): Promise<string> {
  const input = portfolioAssessmentInputSchema.parse(raw);
  const id = randomUUID();
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
        report: JSON.stringify(input.report ?? {}),
        costUsd: input.costUsd,
        createdById: input.createdById,
      },
    }),
    ...childRows(id, input),
  ]);
  return id;
}

/** The statuses of a run that has not ended (#1668). */
const LIVE_STATUSES = ["pending", "running"] as const;

/**
 * #1625 — fill in an assessment created `pending`: its result fields and every
 * child row, in one batch transaction. Child rows already there (a retried
 * completion) are replaced, never doubled. The source, scope and creator it
 * was started with do not change.
 *
 * #1668 — only a run still `pending` or `running` completes: `failed` is
 * final. A stalled run the sweep failed meanwhile (its starter and any poller
 * were told so) is not flipped back. The parent update matches on the status
 * too and comes first, so when it matches nothing Prisma rejects it (`P2025`)
 * and the whole batch, child rows included, rolls back. Returns whether it
 * was written.
 */
export async function completePortfolioAssessment(
  id: string,
  raw: PortfolioAssessmentInput,
): Promise<boolean> {
  const input = portfolioAssessmentInputSchema.parse(raw);
  try {
    await prisma.$transaction([
      prisma.portfolioAssessment.update({
        where: { id, status: { in: [...LIVE_STATUSES] } },
        data: {
          statement: input.statement,
          productIds: JSON.stringify(input.productIds),
          status: input.status,
          portfolioVerdict: input.portfolioVerdict,
          summary: input.summary,
          report: JSON.stringify(input.report ?? {}),
          costUsd: input.costUsd,
        },
      }),
      prisma.portfolioAssessmentProduct.deleteMany({ where: { assessmentId: id } }),
      prisma.portfolioAssessmentRepo.deleteMany({ where: { assessmentId: id } }),
      ...childRows(id, input),
    ]);
    return true;
  } catch (err) {
    // Prisma's "record to update not found": the run is no longer live.
    if ((err as { code?: unknown } | null)?.code === "P2025") return false;
    throw err;
  }
}

/**
 * #1625 — move an assessment to `running` (from `pending`) or `failed` (from
 * `pending` or `running`). #1668 — conditional, so neither can reopen a run
 * that ended: a swept `failed` row stays failed, a `completed` one completed.
 * Returns whether the row moved.
 */
export async function setPortfolioAssessmentStatus(
  id: string,
  status: "running" | "failed",
): Promise<boolean> {
  const from = status === "running" ? ["pending"] : [...LIVE_STATUSES];
  const { count } = await prisma.portfolioAssessment.updateMany({
    where: { id, status: { in: from } },
    data: { status },
  });
  return count > 0;
}

/**
 * #1657 — a running assessment's heartbeat: refresh `updatedAt` (Prisma's
 * `@updatedAt`) so {@link failInterruptedPortfolioAssessments} can tell a live
 * run from one whose process stopped. Only a row still `running` is touched.
 */
export async function touchPortfolioAssessment(id: string): Promise<void> {
  await prisma.portfolioAssessment.updateMany({
    where: { id, status: "running" },
    data: { status: "running" },
  });
}

/**
 * #1657 — fail every assessment still `pending` or `running` whose row has not
 * changed since `staleBefore`. A run executes only in the process that started
 * it, and a live one beats every `PORTFOLIO_ASSESSMENT_HEARTBEAT_MS`, so such a
 * row has no process left: it is failed, never resumed (resuming would spend
 * model calls nobody is waiting for). Each row is failed by a conditional
 * update, so a row that beats meanwhile is not taken. #1668 — returns the ids
 * of the rows it failed, so the sweep can tell their `job:{id}` subscribers.
 */
export async function failInterruptedPortfolioAssessments(staleBefore: Date): Promise<string[]> {
  const stale = { status: { in: [...LIVE_STATUSES] }, updatedAt: { lt: staleBefore } };
  const rows = await prisma.portfolioAssessment.findMany({ where: stale, select: { id: true } });
  const failed: string[] = [];
  for (const { id } of rows) {
    const { count } = await prisma.portfolioAssessment.updateMany({
      where: { id, ...stale },
      data: { status: "failed" },
    });
    if (count > 0) failed.push(id);
  }
  return failed;
}

/**
 * #1625 — the newest assessments naming `productId`, or else those `createdById`
 * started, newest first. Ids only: every reader re-filters what it may see.
 *
 * #1657 — "naming" a product means a row the run could read: a `restricted`
 * row is only the id its starter supplied for a product they could not read,
 * so it never lists the assessment under that product. `before` pages on
 * (`createdAt`, `id`) from the last row of the previous page.
 */
export async function listPortfolioAssessmentIds(filter: {
  productId?: string;
  createdById?: string;
  take: number;
  before?: { createdAt: Date; id: string };
}): Promise<Array<{ id: string; createdAt: Date }>> {
  const scope: Prisma.PortfolioAssessmentWhereInput = filter.productId
    ? { products: { some: { productId: filter.productId, coverage: { not: "restricted" } } } }
    : { createdById: filter.createdById };
  const before = filter.before;
  return prisma.portfolioAssessment.findMany({
    where: before
      ? {
          AND: [
            scope,
            {
              OR: [
                { createdAt: { lt: before.createdAt } },
                { createdAt: before.createdAt, id: { lt: before.id } },
              ],
            },
          ],
        }
      : scope,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: filter.take,
    select: { id: true, createdAt: true },
  });
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

/**
 * Read an assessment back with its product and repo rows, or null when there is
 * none. This checks no access: the table carries no workspace, and an
 * `all-accessible` assessment names products across workspaces. A route that
 * serves one (#1625) must re-check the caller's access to each product row and
 * each repo row's repo, as the product reads do (#1258), before returning it.
 */
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
    // `{}` (no report yet, or a row from before #1624) and anything unreadable read as none.
    report: portfolioReportSchema.safeParse(parseJson<unknown>(row.report, null)).data ?? null,
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
