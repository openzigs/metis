/**
 * Issue #2345 (epic #2328) — a change request as the source of an impact
 * analysis or a portfolio check: its requirements, read by the server itself
 * so the form never re-sends what the analyst already wrote.
 *
 * The change-request id is user input (OWASP A01). It is resolved through the
 * caller's project-access check BEFORE any requirement is read, and an unknown,
 * deleted or unreadable change request answers alike (404, no existence
 * oracle). The requirements are those of that run only (scoped on the run AND
 * its project), live, and not rejected or deferred: a rejected requirement is
 * not part of the change, a deferred one not part of this change.
 */
import { AppError } from "../../middleware/error-handler.js";
import { prisma } from "../prisma.js";
import { clampTitle, sourcelessRunTitle } from "./change-request.js";

/** A requirement of a change request, as a check reads it. */
export interface ChangeRequestRequirement {
  id: string;
  title: string;
  body: string;
  acceptanceCriteria: string | null;
  /** `approved`, or not yet (`draft`, or no status recorded). */
  approved: boolean;
}

export interface ChangeRequestSource {
  id: string;
  projectId: string;
  title: string;
  requirements: ChangeRequestRequirement[];
}

/** The review statuses whose requirements a change request's checks include. */
export const CHECKED_REVIEW_STATUSES = ["draft", "approved"] as const;

/**
 * The change request `analysisId` and its checkable requirements, or 404 when
 * it does not exist, was deleted, or `canReadProject` refuses its project.
 */
export async function loadChangeRequestSource(
  analysisId: string,
  canReadProject: (projectId: string) => Promise<boolean>,
): Promise<ChangeRequestSource> {
  const run = await readableChangeRequest(analysisId, canReadProject);
  if (!run) throw new AppError(404, "NOT_FOUND", "Change request not found");
  const rows = await prisma.requirement.findMany({
    where: {
      analysisId: run.id,
      projectId: run.projectId,
      deletedAt: null,
      OR: [{ reviewStatus: null }, { reviewStatus: { in: [...CHECKED_REVIEW_STATUSES] } }],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, title: true, body: true, acceptanceCriteria: true, reviewStatus: true },
  });
  return {
    id: run.id,
    projectId: run.projectId,
    title: run.title?.trim() ? clampTitle(run.title) : sourcelessRunTitle(run.startedAt),
    requirements: rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      acceptanceCriteria: r.acceptanceCriteria,
      approved: r.reviewStatus === "approved",
    })),
  };
}

/**
 * The live change request `analysisId` when `canReadProject` allows its project,
 * else null: an unknown, deleted and unreadable one answer alike. The lists of a
 * change request's checks (`?analysisId=`) ask this first, so a reader of only
 * another project of a run started from it is told nothing about it.
 */
export async function readableChangeRequest(
  analysisId: string,
  canReadProject: (projectId: string) => Promise<boolean>,
): Promise<{ id: string; projectId: string; title: string | null; startedAt: Date } | null> {
  const run = await prisma.analysis.findFirst({
    where: { id: analysisId, deletedAt: null },
    select: { id: true, projectId: true, title: true, startedAt: true },
  });
  return run && (await canReadProject(run.projectId)) ? run : null;
}

/** A change request with no requirement to check is a 400, said in words. */
export function assertHasRequirements(source: ChangeRequestSource): void {
  if (source.requirements.length === 0) {
    throw new AppError(
      400,
      "NO_REQUIREMENTS",
      "This change request has no draft or approved requirements to check yet.",
    );
  }
}

/**
 * The change request `analysisId` named for a link back, or null when it is
 * gone. Scoped on its project too: a caller passes a project the reader may
 * read, so a run of another project is never named.
 */
export async function changeRequestRef(
  analysisId: string | null | undefined,
  projectIds: readonly string[],
): Promise<{ id: string; projectId: string; title: string } | null> {
  if (!analysisId || projectIds.length === 0) return null;
  const run = await prisma.analysis.findFirst({
    where: { id: analysisId, projectId: { in: [...projectIds] }, deletedAt: null },
    select: { id: true, projectId: true, title: true, startedAt: true },
  });
  if (!run) return null;
  return {
    id: run.id,
    projectId: run.projectId,
    title: run.title?.trim() ? clampTitle(run.title) : sourcelessRunTitle(run.startedAt),
  };
}
