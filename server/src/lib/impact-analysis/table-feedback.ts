/**
 * Relevance feedback on affected tables — Issue #966 (Epic #960).
 *
 * Lets a BA mark an affected-table row `relevant` / `not-relevant` on an impact
 * item. v1 is CAPTURE-ONLY: nothing in this module feeds the #936 LLM relevance
 * filter or any other engine/filter behavior — the persisted rows are read-only
 * signal, harvested (human-reviewed) into the eval corpus by
 * `server/src/lib/eval/impact-recall/feedback-harvest.ts`.
 *
 * Idempotent per (impactItemId, tableName, columnName, userId): the compound
 * unique constraint includes the NULLABLE `columnName`, so — mirroring
 * `schema-usage-override.ts` — writes go through `findFirst` + `create`/`update`
 * rather than `upsert` (Prisma's generated compound-unique `where` cannot match
 * a NULL column, a known limitation).
 */
import type { PrismaClient } from "@prisma/client";
import type {
  ImpactTableFeedbackInput,
  ImpactTableFeedbackVerdict,
  ImpactTableFeedbackView,
} from "@metis/shared";
import { IMPACT_TABLE_FEEDBACK_VERDICTS } from "@metis/shared";

type FeedbackDelegate = PrismaClient["impactTableFeedback"];

export interface TableFeedbackPrisma {
  impactItem: Pick<PrismaClient["impactItem"], "findUnique">;
  impactTableFeedback: Pick<FeedbackDelegate, "findFirst" | "create" | "update" | "deleteMany">;
}

export interface FeedbackTargetItem {
  id: string;
  impactAnalysisId: string;
  projectId: string;
}

interface FeedbackRow {
  id: string;
  impactItemId: string;
  tableName: string;
  columnName: string | null;
  verdict: string;
  userId: string;
  userDisplayName: string;
  createdAt: Date;
}

function toVerdict(v: string): ImpactTableFeedbackVerdict {
  return (IMPACT_TABLE_FEEDBACK_VERDICTS as readonly string[]).includes(v)
    ? (v as ImpactTableFeedbackVerdict)
    : "relevant";
}

function toView(row: FeedbackRow): ImpactTableFeedbackView {
  return {
    id: row.id,
    impactItemId: row.impactItemId,
    tableName: row.tableName,
    columnName: row.columnName,
    verdict: toVerdict(row.verdict),
    userId: row.userId,
    userDisplayName: row.userDisplayName,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Resolve the impact item a feedback mutation targets, scoped to the given
 * analysis id. Returns `null` when the item does not exist OR belongs to a
 * DIFFERENT analysis — the route maps either case to a plain 404 so it never
 * leaks cross-analysis existence.
 */
export async function findFeedbackTargetItem(
  prisma: TableFeedbackPrisma,
  analysisId: string,
  itemId: string,
): Promise<FeedbackTargetItem | null> {
  const item = (await prisma.impactItem.findUnique({
    where: { id: itemId },
    select: { id: true, impactAnalysisId: true, projectId: true },
  })) as FeedbackTargetItem | null;
  if (!item || item.impactAnalysisId !== analysisId) return null;
  return item;
}

/**
 * Create or update a BA's feedback mark. Idempotent per
 * (impactItemId, tableName, columnName, userId) — re-marking the same target
 * updates the verdict in place rather than duplicating a row.
 */
export async function upsertTableFeedback(
  prisma: TableFeedbackPrisma,
  analysisId: string,
  itemId: string,
  input: ImpactTableFeedbackInput,
  actor: { id: string; displayName: string },
): Promise<ImpactTableFeedbackView> {
  const columnName = input.columnName ?? null;
  const existing = (await prisma.impactTableFeedback.findFirst({
    where: { impactItemId: itemId, tableName: input.tableName, columnName, userId: actor.id },
    select: { id: true },
  })) as { id: string } | null;

  let row: FeedbackRow;
  if (existing) {
    row = (await prisma.impactTableFeedback.update({
      where: { id: existing.id },
      data: { verdict: input.verdict, userDisplayName: actor.displayName },
    })) as FeedbackRow;
  } else {
    row = (await prisma.impactTableFeedback.create({
      data: {
        impactAnalysisId: analysisId,
        impactItemId: itemId,
        tableName: input.tableName,
        columnName,
        verdict: input.verdict,
        userId: actor.id,
        userDisplayName: actor.displayName,
      },
    })) as FeedbackRow;
  }
  return toView(row);
}

/**
 * Delete a feedback mark, scoped to its own analysis + item + the SAME user who
 * created it (IDOR-safe — a caller can only remove their own mark). Returns
 * `true` when a row was removed.
 */
export async function deleteTableFeedback(
  prisma: TableFeedbackPrisma,
  analysisId: string,
  itemId: string,
  feedbackId: string,
  userId: string,
): Promise<boolean> {
  const res = await prisma.impactTableFeedback.deleteMany({
    where: { id: feedbackId, impactItemId: itemId, impactAnalysisId: analysisId, userId },
  });
  return res.count > 0;
}
