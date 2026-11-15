/**
 * #2554 — which checkpoints (approval requests) of a run a reader may act on:
 * the ones whose text they can see. A checkpoint shows the reader the entry of
 * the run's reviewed list it decides, and that entry is the restricted
 * placeholder when the reader cannot see its sources (#2447,
 * `redactStructuredList`). Approving or rejecting it would decide text they
 * were never shown, so the routes refuse it, and the approvals list marks it.
 *
 * The rule is the snapshot's: an entry promoted into a requirement is decided
 * by that requirement's recorded sources; one not yet promoted (and every
 * evidence or clarification checkpoint, which no requirement records) rests on
 * the run as a whole (`canSeeRun`). One guard load for every checkpoint asked
 * about.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { loadSourceGuard, type SourceGuardedRow, type SourceReader } from "./source-redaction.js";

/** A checkpoint as far as its visibility goes: its id and the entry it decides. */
export interface CheckpointRow {
  id: string;
  itemId: string;
}

/** The checkpoints of run `analysisId` matching `where` (one, the pending, a set of entries). */
export async function checkpointRows(
  analysisId: string,
  where: Prisma.ApprovalRequestWhereInput = {},
): Promise<CheckpointRow[]> {
  return prisma.approvalRequest.findMany({
    where: { ...where, analysisId },
    select: { id: true, itemId: true },
  });
}

/** Item ids per `IN (...)` list: well under SQLite's bound-parameter limit. */
const ID_BATCH = 500;

/**
 * Of `approvals` (checkpoints of run `analysisId`), the ids `reader` cannot see
 * the entry of. A reader that cannot be resolved sees nothing restricted; any
 * other failure rejects, and the caller must then refuse.
 */
export async function hiddenCheckpointIds(
  reader: SourceReader,
  analysisId: string,
  approvals: readonly CheckpointRow[],
): Promise<Set<string>> {
  if (approvals.length === 0) return new Set();
  const itemIds = [...new Set(approvals.map((a) => a.itemId))];
  const promoted: Array<SourceGuardedRow & { promotedStructuredId: string | null }> = [];
  for (let i = 0; i < itemIds.length; i += ID_BATCH) {
    promoted.push(
      ...(await prisma.requirement.findMany({
        where: {
          analysisId,
          promotedStructuredId: { in: itemIds.slice(i, i + ID_BATCH) },
          deletedAt: null,
        },
        select: { analysisId: true, sourceIds: true, promotedStructuredId: true },
      })),
    );
  }
  const byItem = new Map<string, SourceGuardedRow[]>();
  for (const row of promoted) {
    if (!row.promotedStructuredId) continue;
    byItem.set(row.promotedStructuredId, [...(byItem.get(row.promotedStructuredId) ?? []), row]);
  }
  const guard = await loadSourceGuard(reader, [{ analysisId, sourceIds: null }, ...promoted]);
  return new Set(
    approvals
      .filter((a) => {
        const rows = byItem.get(a.itemId);
        return rows ? !rows.every((r) => guard.canSee(r)) : !guard.canSeeRun(analysisId);
      })
      .map((a) => a.id),
  );
}
