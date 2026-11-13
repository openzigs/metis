/**
 * Issue #2347 (epic #2328) — the project's requirements across every change
 * request, as one list: the Requirements tab.
 *
 * Each row carries its change request (by title), its review status and the
 * state of the latest formal review covering it, so an analyst can act on it
 * (edit, approve, request a review) without opening the analysis page. The
 * server does the filtering and paging: a project holds several hundred
 * requirements.
 *
 * Access (OWASP A01): the route checks the caller may open the project; every
 * query here filters on `projectId`, and the run each row belongs to must be
 * a live run of the SAME project, so another project's requirement or run id
 * never matches. The title search is one parameterised query per backend, the
 * term a bound value with `%`, `_` and `\` escaped so they match literally:
 * `ILIKE` on Postgres (its client cannot express `mode: "insensitive"`, the
 * seam `requirement-link-service.ts` uses) and `LIKE … ESCAPE` on SQLite, whose
 * `LIKE` already folds ASCII case (a Prisma `contains` there reads `%` as a
 * wildcard).
 */

import { Prisma, prisma, resolveDatabaseProvider } from "../prisma.js";
import { resolveRequirementReviewStatus } from "../analysis/analysis-service.js";
import { parseRequirementLabels } from "../analysis/requirement-labels.js";

export const REQUIREMENT_LIST_STATUSES = ["draft", "approved", "rejected", "deferred"] as const;
export type RequirementListStatus = (typeof REQUIREMENT_LIST_STATUSES)[number];

/** Review statuses that stand for a requirement's review (a closed one does not). */
const STANDING_REVIEW_STATUSES = ["draft", "in_review", "rejected", "approved"] as const;

export const PROJECT_REQUIREMENTS_PAGE_SIZE_MAX = 100;
/** Most ids a Postgres title search narrows to before the page is read. */
const SEARCH_ID_CAP = 5_000;

export interface ProjectRequirementsQuery {
  /** One change request (analysis run) of the project. */
  analysisId?: string;
  status?: RequirementListStatus;
  /** A substring of the title, case-insensitive. */
  q?: string;
  page: number;
  pageSize: number;
}

export interface ProjectRequirementRow {
  id: string;
  title: string;
  body: string;
  version: number;
  reviewStatus: RequirementListStatus;
  updatedAt: string;
  changeRequest: { id: string; title: string };
  /** The latest standing formal review covering it; null when none. */
  review: { id: string; title: string; status: string } | null;
}

export interface ProjectRequirementsPage {
  items: ProjectRequirementRow[];
  total: number;
  page: number;
  pageSize: number;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The status filter as a `where`: an unset status reads as `draft` (awaiting review). */
function statusWhere(status: RequirementListStatus): Prisma.RequirementWhereInput {
  return status === "draft"
    ? { OR: [{ reviewStatus: "draft" }, { reviewStatus: null }] }
    : { reviewStatus: status };
}

/** The ids of the project's live requirements whose title contains `q`, any case. */
async function idsMatchingTitle(projectId: string, q: string): Promise<string[]> {
  const pattern = `%${escapeLike(q)}%`;
  const rows =
    resolveDatabaseProvider() === "postgresql"
      ? await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "requirements"
          WHERE "projectId" = ${projectId}
            AND "deletedAt" IS NULL
            AND "title" ILIKE ${pattern}
          LIMIT ${SEARCH_ID_CAP}
        `)
      : await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "requirements"
          WHERE "projectId" = ${projectId}
            AND "deletedAt" IS NULL
            AND "title" LIKE ${pattern} ESCAPE '\\'
          LIMIT ${SEARCH_ID_CAP}
        `);
  return rows.map((r) => r.id);
}

export async function listProjectRequirements(
  projectId: string,
  query: ProjectRequirementsQuery,
): Promise<ProjectRequirementsPage> {
  const q = query.q?.trim() ?? "";
  const titleWhere: Prisma.RequirementWhereInput = q
    ? { id: { in: await idsMatchingTitle(projectId, q) } }
    : {};
  const where: Prisma.RequirementWhereInput = {
    projectId,
    deletedAt: null,
    analysis: { is: { projectId, deletedAt: null } },
    ...(query.analysisId ? { analysisId: query.analysisId } : {}),
    ...(query.status ? statusWhere(query.status) : {}),
    ...titleWhere,
  };
  const [total, rows] = await Promise.all([
    prisma.requirement.count({ where }),
    prisma.requirement.findMany({
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      select: {
        id: true,
        title: true,
        body: true,
        version: true,
        reviewStatus: true,
        labels: true,
        updatedAt: true,
        analysis: { select: { id: true, title: true, startedAt: true } },
        reviewItems: {
          where: {
            reviewRequest: { projectId, status: { in: [...STANDING_REVIEW_STATUSES] } },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { reviewRequest: { select: { id: true, title: true, status: true } } },
        },
      },
    }),
  ]);
  return {
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      version: r.version,
      reviewStatus: resolveRequirementReviewStatus(
        r.reviewStatus,
        parseRequirementLabels(r.labels),
      ) as RequirementListStatus,
      updatedAt: r.updatedAt.toISOString(),
      changeRequest: {
        id: r.analysis.id,
        // Every run stores a title since #2341; the date is the last resort.
        title: r.analysis.title ?? `Analysis of ${r.analysis.startedAt.toISOString().slice(0, 10)}`,
      },
      review: r.reviewItems[0]?.reviewRequest ?? null,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}
