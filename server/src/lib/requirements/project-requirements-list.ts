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
import { CHECKPOINT_EDITORS_KEY } from "../analysis/checkpoint-authorship.js";
import { editedInCheckpoint, isAuthoringVersion } from "./requirement-version-service.js";

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
  /**
   * #2452 — the viewer wrote or edited it, and the project does not allow
   * self-approval, so their Approve would be refused (`SELF_APPROVAL_FORBIDDEN`).
   * Set only on a row the viewer could otherwise approve; omitted otherwise.
   */
  selfApprovalForbidden?: true;
}

/** #2452 — who is reading the list, for {@link ProjectRequirementRow.selfApprovalForbidden}. */
export interface RequirementListViewer {
  userId: string;
  /** Holds `requirement.approve`; without it Approve is refused regardless. */
  canApprove: boolean;
}

export interface ProjectRequirementsPage {
  items: ProjectRequirementRow[];
  total: number;
  /**
   * True when the title search matched more than {@link SEARCH_ID_CAP}
   * requirements: the list then holds the most recently updated of them, and
   * `total` counts only those, so the true total is at least `total`.
   */
  totalIsLowerBound: boolean;
  page: number;
  pageSize: number;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** The statuses other than `draft`, which an unset or unknown status reads as. */
const DECIDED_STATUSES = ["approved", "rejected", "deferred"] as const;

/** A legacy `review:<status>` label in the `labels` JSON column (#1016). */
function hasLegacyLabel(status: string): Prisma.RequirementWhereInput {
  return { labels: { contains: `"review:${status}"` } };
}

/**
 * The status filter as a `where`, agreeing with the status each row SHOWS
 * (`resolveRequirementReviewStatus`): the typed column, else a legacy
 * `review:*` label (#1016, as `heldReviewStatus` and the hub's counts read
 * it), else `draft` (awaiting review). So a legacy-approved row (null column,
 * `review:approved` label) is listed under Approved, never Awaiting review.
 */
function statusWhere(status: RequirementListStatus): Prisma.RequirementWhereInput {
  if (status === "draft") {
    return {
      OR: [
        // A set column that is not a decided status (`draft`, or unknown) reads as draft.
        { reviewStatus: { notIn: [...DECIDED_STATUSES] } },
        // An unset column reads as draft unless a legacy label decides it.
        { reviewStatus: null, NOT: DECIDED_STATUSES.map(hasLegacyLabel) },
      ],
    };
  }
  return { OR: [{ reviewStatus: status }, { reviewStatus: null, ...hasLegacyLabel(status) }] };
}

/**
 * The ids of the project's live requirements whose title contains `q`, any
 * case: at most {@link SEARCH_ID_CAP}, the most recently updated first (the
 * order the list shows), and whether more matched than that.
 */
async function idsMatchingTitle(
  projectId: string,
  q: string,
): Promise<{ ids: string[]; capped: boolean }> {
  const pattern = `%${escapeLike(q)}%`;
  // One past the cap, to tell "exactly the cap" from "more than it".
  const limit = SEARCH_ID_CAP + 1;
  const rows =
    resolveDatabaseProvider() === "postgresql"
      ? await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "requirements"
          WHERE "projectId" = ${projectId}
            AND "deletedAt" IS NULL
            AND "title" ILIKE ${pattern}
          ORDER BY "updatedAt" DESC, "id" ASC
          LIMIT ${limit}
        `)
      : await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "requirements"
          WHERE "projectId" = ${projectId}
            AND "deletedAt" IS NULL
            AND "title" LIKE ${pattern} ESCAPE '\\'
          ORDER BY "updatedAt" DESC, "id" ASC
          LIMIT ${limit}
        `);
  return {
    ids: rows.slice(0, SEARCH_ID_CAP).map((r) => r.id),
    capped: rows.length > SEARCH_ID_CAP,
  };
}

/**
 * #2452 — the ids among `requirementIds` (the project's, not yet approved)
 * that `userId` may not approve because they are an author and the project
 * does not allow self-approval. The same reading as the approve write's
 * maker-checker (`updateRequirementWithHistory`): a version of theirs that
 * changed the wording, or an edit of theirs in the approval checkpoint. Every
 * read filters on the project. Exported for its project-scoping test.
 */
export async function selfApprovalForbiddenIds(
  projectId: string,
  requirementIds: string[],
  userId: string,
): Promise<Set<string>> {
  const blocked = new Set<string>();
  if (requirementIds.length === 0) return blocked;
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { allowSelfApproval: true },
  });
  if (project?.allowSelfApproval === true) return blocked;
  const [versions, checkpointRows] = await Promise.all([
    prisma.requirementVersion.findMany({
      where: { requirementId: { in: requirementIds }, actorId: userId, requirement: { projectId } },
      select: { requirementId: true, changedFields: true },
    }),
    // Only a run whose metadata records checkpoint editors can name one.
    prisma.requirement.findMany({
      where: {
        id: { in: requirementIds },
        projectId,
        promotedStructuredId: { not: null },
        analysis: { is: { projectId, metadata: { contains: CHECKPOINT_EDITORS_KEY } } },
      },
      select: {
        id: true,
        promotedStructuredId: true,
        promotedStructuredRunId: true,
        analysis: { select: { metadata: true } },
      },
    }),
  ]);
  for (const v of versions) {
    if (isAuthoringVersion(v.changedFields)) blocked.add(v.requirementId);
  }
  for (const row of checkpointRows) {
    if (editedInCheckpoint(row, userId)) blocked.add(row.id);
  }
  return blocked;
}

/**
 * #2462 — whether `GET /api/analyses/:id` should work out the flag. The page
 * polls that route every 2.5 s while a run is pending or running, and the flag
 * costs up to three reads, so it is worked out only once the run has settled
 * (completed, failed, cancelled) or while its approval checkpoint is open
 * (`metadata.promotionBlocked.blocked`). Before that, no card is actionable.
 */
export function selfApprovalFlagDue(snapshot: {
  status: string;
  metadata: Record<string, unknown> | null;
}): boolean {
  if (snapshot.status !== "pending" && snapshot.status !== "running") return true;
  const gate = snapshot.metadata?.promotionBlocked as { blocked?: unknown } | undefined;
  return gate?.blocked === true;
}

/**
 * #2462 — the same flag on another read of one project's requirements: the
 * change request page's cards (`GET /api/analyses/:id`). Only a row the viewer
 * could otherwise approve is read, as on the list: not yet approved, and the
 * viewer holds requirement.approve. Every other row comes back unchanged.
 */
export async function flagSelfApprovalForbidden<T extends { id: string; reviewStatus: string }>(
  projectId: string,
  rows: T[],
  viewer: RequirementListViewer | undefined,
): Promise<Array<T & { selfApprovalForbidden?: true }>> {
  if (!viewer?.canApprove) return rows;
  const forbidden = await selfApprovalForbiddenIds(
    projectId,
    rows.filter((r) => r.reviewStatus !== "approved").map((r) => r.id),
    viewer.userId,
  );
  return rows.map((r) => (forbidden.has(r.id) ? { ...r, selfApprovalForbidden: true } : r));
}

export async function listProjectRequirements(
  projectId: string,
  query: ProjectRequirementsQuery,
  viewer?: RequirementListViewer,
): Promise<ProjectRequirementsPage> {
  const q = query.q?.trim() ?? "";
  const search = q ? await idsMatchingTitle(projectId, q) : null;
  const where: Prisma.RequirementWhereInput = {
    projectId,
    deletedAt: null,
    analysis: { is: { projectId, deletedAt: null } },
    ...(query.analysisId ? { analysisId: query.analysisId } : {}),
    ...(query.status ? { AND: [statusWhere(query.status)] } : {}),
    ...(search ? { id: { in: search.ids } } : {}),
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
  const statusOf = (r: (typeof rows)[number]) =>
    resolveRequirementReviewStatus(
      r.reviewStatus,
      parseRequirementLabels(r.labels),
    ) as RequirementListStatus;
  // #2452 — only rows the viewer could otherwise approve: not yet approved,
  // and the viewer holds requirement.approve.
  const forbidden = viewer?.canApprove
    ? await selfApprovalForbiddenIds(
        projectId,
        rows.filter((r) => statusOf(r) !== "approved").map((r) => r.id),
        viewer.userId,
      )
    : new Set<string>();
  return {
    items: rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      version: r.version,
      reviewStatus: statusOf(r),
      updatedAt: r.updatedAt.toISOString(),
      changeRequest: {
        id: r.analysis.id,
        // Every run stores a title since #2341; the date is the last resort.
        // The UI's filter names it the same way (`changeRequestName`).
        title:
          r.analysis.title?.trim() ||
          `Analysis of ${r.analysis.startedAt.toISOString().slice(0, 10)}`,
      },
      review: r.reviewItems[0]?.reviewRequest ?? null,
      ...(forbidden.has(r.id) ? { selfApprovalForbidden: true as const } : {}),
    })),
    total,
    totalIsLowerBound: search?.capped ?? false,
    page: query.page,
    pageSize: query.pageSize,
  };
}
