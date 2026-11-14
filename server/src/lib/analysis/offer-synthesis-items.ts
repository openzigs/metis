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
import { appendStructuredRequirements, reviseStructuredRequirements } from "./analysis-service.js";
import { createApprovalRequests } from "./approval-checkpoint.js";
import {
  latestRequirementApprovals,
  offerUnmatchedSynthesisItems,
} from "./approved-requirement-set.js";
import { offerElicitedNfrs, type DroppedNfr } from "./elicited-nfr-requirements.js";
import type { StructuredRequirement } from "./types/requirements.js";
import type { Nfr, SynthesizedRequirement } from "@metis/shared";

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

/**
 * Issue #2449 — add the NFRs a gate-blocked run elicited to the reviewed list
 * and raise an approval for each (`offerElicitedNfrs`), so the checkpoint lists
 * every requirement promotion writes: an approved one is promoted as the NFR,
 * a rejected one is not written. Only on an analysis whose requirements go
 * through the checkpoint, as {@link offerUnmatchedItemsForReview}. Every NFR
 * it did not offer is logged (#1648).
 *
 * #2427 — one round of NFRs at a time. The elicitor is a model and words its
 * NFRs differently on each run, so every re-run used to add its rewordings to
 * the ones still pending, each holding the gate. An NFR an earlier run offered
 * that is still pending is withdrawn (its approval with it) unless this run
 * offers it again, when it keeps its place and its approval. A decided one,
 * approved or rejected, stays listed, and so is never offered again.
 *
 * Returns the requirements it added and the ids it withdrew.
 */
export async function offerElicitedNfrsForReview(
  analysisId: string,
  input: {
    nfrs: Nfr[];
    findingIdsByIndex: string[];
    synthesized: readonly SynthesizedRequirement[];
  },
): Promise<{ offered: StructuredRequirement[]; withdrawn: string[] }> {
  const none = { offered: [], withdrawn: [] };
  if (input.nfrs.length === 0) return none;
  const approvals = await prisma.approvalRequest.findMany({
    where: { analysisId, type: "requirement" },
    select: { itemId: true, status: true, createdAt: true },
  });
  if (approvals.length === 0) return none;
  const pending = new Set(
    [...latestRequirementApprovals(approvals).values()]
      .filter((a) => a.status === "pending")
      .map((a) => a.itemId),
  );
  let offered: StructuredRequirement[] = [];
  let withdrawn: string[] = [];
  let dropped: DroppedNfr[] = [];
  await reviseStructuredRequirements(analysisId, (list) => {
    const undecided = (r: StructuredRequirement) =>
      r.elicitedNfr !== undefined && pending.has(r.id);
    const out = offerElicitedNfrs({ ...input, structured: list.filter((r) => !undecided(r)) });
    dropped = out.dropped;
    const again = new Set(out.offered.map((r) => r.id));
    withdrawn = list.filter((r) => undecided(r) && !again.has(r.id)).map((r) => r.id);
    const kept = list.filter((r) => !undecided(r) || again.has(r.id));
    const listed = new Set(kept.map((r) => r.id));
    offered = out.offered.filter((r) => !listed.has(r.id));
    if (offered.length === 0 && withdrawn.length === 0) return null;
    return [...kept, ...offered];
  });
  if (dropped.length > 0) {
    log.info("Elicited NFRs not offered for review", { analysisId, dropped });
  }
  if (withdrawn.length > 0) {
    // Only a still-pending approval: one decided meanwhile is the analyst's.
    await prisma.approvalRequest.deleteMany({
      where: { analysisId, type: "requirement", status: "pending", itemId: { in: withdrawn } },
    });
    log.info("Withdrew elicited NFRs an earlier run offered", {
      analysisId,
      withdrawnCount: withdrawn.length,
    });
  }
  if (offered.length > 0) {
    await createApprovalRequests(
      analysisId,
      offered.map((r) => ({ type: "requirement" as const, itemId: r.id })),
    );
    log.info("Offered elicited NFRs for review", { analysisId, offeredCount: offered.length });
  }
  return { offered, withdrawn };
}

/**
 * Issue #2427 review — how many requirements of the reviewed list await a
 * decision: those whose latest approval is pending, or that have none. The
 * checkpoint states this count, so a checkpoint reopened after it was approved
 * says "3 awaiting" for 3 pending, not the list's 4 (#2330).
 */
export async function countUndecidedRequirements(
  analysisId: string,
  reviewed: readonly StructuredRequirement[],
): Promise<number> {
  const approvals = await prisma.approvalRequest.findMany({
    where: { analysisId, type: "requirement" },
    select: { itemId: true, status: true, createdAt: true },
  });
  const latest = latestRequirementApprovals(approvals);
  return reviewed.filter((r) => (latest.get(r.id)?.status ?? "pending") === "pending").length;
}
