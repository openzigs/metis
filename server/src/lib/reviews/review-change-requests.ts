/**
 * Issue #2341 — name the change request(s) a review is about.
 *
 * A review's items are requirements, and a requirement belongs to the analysis
 * run (the change request) that produced it. The Reviews list shows each
 * review's change request by title, so a reviewer can tell what the review is
 * for without opening it.
 *
 * Only rows of the review's own project are read, so an item can never surface
 * another project's run. Best-effort: a label is never worth failing the
 * review read, so any error leaves `changeRequests` empty.
 */
import { changeRequestDetails } from "../analysis/change-request.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("review-change-requests");

export interface ReviewChangeRequest {
  id: string;
  title: string;
}

type ReviewLike = { projectId: string; items: Array<{ requirementId: string | null }> };

/** The change requests of one project's requirement ids, in first-seen order. */
async function changeRequestsByRequirement(
  projectId: string,
  requirementIds: readonly string[],
): Promise<Map<string, ReviewChangeRequest>> {
  const out = new Map<string, ReviewChangeRequest>();
  if (requirementIds.length === 0) return out;
  const rows = await prisma.requirement.findMany({
    where: { id: { in: [...requirementIds] }, projectId },
    select: { id: true, analysisId: true },
  });
  const runs = await prisma.analysis.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.analysisId))] }, projectId, deletedAt: null },
    select: { id: true, title: true, metadata: true, startedAt: true },
  });
  const details = await changeRequestDetails(projectId, runs);
  for (const r of rows) {
    const d = details.get(r.analysisId);
    if (d) out.set(r.id, { id: r.analysisId, title: d.title });
  }
  return out;
}

/** Attach `changeRequests` (distinct, in item order) to each review. */
export async function attachChangeRequests<T extends ReviewLike>(
  reviews: readonly T[],
): Promise<Array<T & { changeRequests: ReviewChangeRequest[] }>> {
  const idsByProject = new Map<string, Set<string>>();
  for (const review of reviews) {
    const ids = idsByProject.get(review.projectId) ?? new Set<string>();
    for (const item of review.items) if (item.requirementId) ids.add(item.requirementId);
    idsByProject.set(review.projectId, ids);
  }
  const byProject = new Map<string, Map<string, ReviewChangeRequest>>();
  try {
    for (const [projectId, ids] of idsByProject) {
      byProject.set(projectId, await changeRequestsByRequirement(projectId, [...ids]));
    }
  } catch (err) {
    log.warn("could not read the change requests of a review (non-fatal)", {
      error: (err as Error).message,
    });
    return reviews.map((review) => ({ ...review, changeRequests: [] }));
  }
  return reviews.map((review) => {
    const found = byProject.get(review.projectId);
    const seen = new Map<string, ReviewChangeRequest>();
    for (const item of review.items) {
      const cr = item.requirementId ? found?.get(item.requirementId) : undefined;
      if (cr && !seen.has(cr.id)) seen.set(cr.id, cr);
    }
    return { ...review, changeRequests: [...seen.values()] };
  });
}
