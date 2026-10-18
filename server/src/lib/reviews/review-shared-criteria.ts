/**
 * Issue #1203 — tell the review card which requirement items carry
 * acceptance criteria a synthesis item wrote for several requirements.
 *
 * Promotion records that per row in `Analysis.metadata.promotionMatching.shared`.
 * The review card renders the PINNED snapshot, so it receives the record and
 * decides itself whether the pinned criteria are still the promoted ones
 * (`sharedCriteriaToMark` in `@metis/shared`). Siblings carry their rows'
 * current titles, and the item carries the project and analysis its sibling
 * links point into.
 *
 * Best-effort: a note is never worth failing the review read, so any error
 * leaves the items undecorated.
 */
import { findSharedCriteria, type SharedCriteriaRecord } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("review-shared-criteria");

/** What a requirement item gains: `null` when its criteria were not shared. */
export interface ReviewItemSharedCriteria {
  projectId: string;
  analysisId: string;
  record: SharedCriteriaRecord;
}

function parseObject(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Attach `sharedCriteria` to every requirement item of a review. Only rows of
 * the review's own project are read, so an item can never surface another
 * project's analysis.
 */
export async function attachSharedCriteria<
  T extends { projectId: string; items: Array<{ requirementId: string | null }> },
>(
  review: T,
): Promise<
  | T
  | (Omit<T, "items"> & {
      items: Array<T["items"][number] & { sharedCriteria: ReviewItemSharedCriteria | null }>;
    })
> {
  const requirementIds = [
    ...new Set(review.items.map((i) => i.requirementId).filter((id): id is string => !!id)),
  ];
  if (requirementIds.length === 0) return review;
  try {
    const rows = await prisma.requirement.findMany({
      where: { id: { in: requirementIds }, projectId: review.projectId },
      select: { id: true, analysisId: true },
    });
    const analysisOf = new Map(rows.map((r) => [r.id, r.analysisId] as const));
    const analyses = await prisma.analysis.findMany({
      where: {
        id: { in: [...new Set(rows.map((r) => r.analysisId))] },
        projectId: review.projectId,
      },
      select: { id: true, metadata: true },
    });
    const metadataOf = new Map(analyses.map((a) => [a.id, parseObject(a.metadata)] as const));

    const records = new Map<string, { analysisId: string; record: SharedCriteriaRecord }>();
    for (const id of requirementIds) {
      const analysisId = analysisOf.get(id);
      if (!analysisId) continue;
      const record = findSharedCriteria(metadataOf.get(analysisId), id);
      if (record) records.set(id, { analysisId, record });
    }
    // The siblings' current titles, so a renamed sibling is named as it reads now;
    // only live rows of this project, so a deleted sibling is known by its absence.
    const siblingIds = [
      ...new Set(
        [...records.values()].flatMap(({ record }) =>
          record.sharedWith.map((s) => s.requirementId).filter((x): x is string => !!x),
        ),
      ),
    ];
    const titles =
      siblingIds.length > 0
        ? await prisma.requirement.findMany({
            where: { id: { in: siblingIds }, projectId: review.projectId, deletedAt: null },
            select: { id: true, title: true },
          })
        : [];
    const titleOf = new Map(titles.map((t) => [t.id, t.title] as const));

    return {
      ...review,
      items: review.items.map((item) => {
        const found = item.requirementId ? records.get(item.requirementId) : undefined;
        if (!found) return { ...item, sharedCriteria: null };
        const record: SharedCriteriaRecord = {
          ...found.record,
          // A sibling whose row is no longer live has no card to link to: it
          // keeps its promoted title and loses its row id, so the card names it
          // without a link (`approved` still says it was approved).
          sharedWith: found.record.sharedWith.map((s) => {
            const live = s.requirementId ? titleOf.get(s.requirementId) : undefined;
            return live !== undefined ? { ...s, title: live } : { ...s, requirementId: null };
          }),
        };
        return {
          ...item,
          sharedCriteria: { projectId: review.projectId, analysisId: found.analysisId, record },
        };
      }),
    };
  } catch (err) {
    log.warn("could not read shared acceptance criteria for a review (non-fatal)", {
      error: (err as Error).message,
    });
    return review;
  }
}
