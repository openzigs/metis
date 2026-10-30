/**
 * Issue #1569 — at the approval checkpoint, offer the requirements synthesis
 * wrote up that match nothing in the reviewed list, instead of dropping them.
 *
 * Promotion persists the reviewed (structured) list and joins synthesis items
 * onto it (#730, #1033). An item that says it restates no listed requirement
 * (`structuredIds: []`) had nothing to join onto, so its acceptance criteria
 * and evidence were lost and the Approvals tab could only warn about it: 16 in
 * #706 run 10, 4 in run 9. Each such item is now added to the reviewed list as
 * a requirement of its own, with a pending `requirement` approval, so the
 * reviewer approves or rejects it like any other and approving promotes it
 * with the item's criteria and evidence (joined by `synthesisItemKey`).
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { appendStructuredRequirements } from "./analysis-service.js";
import { createApprovalRequests } from "./approval-checkpoint.js";
import { offerUnmatchedSynthesisItems } from "./approved-requirement-set.js";
import type { StructuredRequirement } from "./types/requirements.js";
import type { SynthesizedRequirement } from "@metis/shared";

const log = createChildLogger("offer-synthesis-items");

/**
 * Add the unmatched items to the reviewed list and raise an approval for each.
 * Only on an analysis whose requirements go through the checkpoint (it has
 * `requirement` approvals): elsewhere nothing would ever review them. Returns
 * the requirements it added, none when there was nothing new to offer.
 */
export async function offerUnmatchedItemsForReview(
  analysisId: string,
  synthesized: readonly SynthesizedRequirement[],
): Promise<StructuredRequirement[]> {
  const reviewed = await prisma.approvalRequest.count({
    where: { analysisId, type: "requirement" },
  });
  if (reviewed === 0) return [];
  const offered = await appendStructuredRequirements(analysisId, (list) =>
    offerUnmatchedSynthesisItems(list, synthesized),
  );
  if (offered.length === 0) return offered;
  await createApprovalRequests(
    analysisId,
    offered.map((r) => ({ type: "requirement" as const, itemId: r.id })),
  );
  log.info("Offered synthesis requirements that matched nothing reviewed", {
    analysisId,
    offeredCount: offered.length,
  });
  return offered;
}
