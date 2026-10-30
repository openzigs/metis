/**
 * Issue #1588 — who may turn an approval-checkpoint decision into an APPROVED
 * requirement.
 *
 * "Approved" means signed off by someone holding `project.update`, the
 * permission both requirement write routes demand since #1566. Approving the
 * checkpoint of an analysis stays open to `analysis.run` (a developer can run an
 * analysis end to end), but what it promotes depends on who caused the
 * promotion: with `project.update` the rows are `approved`; without it they
 * are `draft`, for a coordinator to approve through the normal review flow.
 */
import { hasPermission, type RoleKey } from "@metis/shared";
import { SYSTEM_ACTOR_ID } from "../audit/system-actor.js";
import { loadLiveAuthPayload } from "../auth/live-auth-payload.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";

const log = createChildLogger("checkpoint-sign-off");

/** The permission an `approved` requirement stands for (#1566, #1588). */
export const REQUIREMENT_SIGN_OFF_PERMISSION = "project.update" as const;

/** How a checkpoint promotion records the rows it writes. */
export interface PromotionSignOff {
  /** `true`: the rows are written `approved`; `false`: `draft`. */
  asApproved: boolean;
}

/** The review status a checkpoint promotion writes its rows with. */
export function promotedReviewStatus(signOff: PromotionSignOff): "approved" | "draft" {
  return signOff.asApproved ? "approved" : "draft";
}

/** Sign-off for a request's caller, from the role the permission middleware read. */
export function signOffForRole(role: RoleKey): PromotionSignOff {
  return { asApproved: hasPermission(role, REQUIREMENT_SIGN_OFF_PERMISSION) };
}

/**
 * Sign-off for a user who is not the request's caller — the starter of a run
 * the orchestrator persists, or whoever asked for drafts. Read from durable
 * state (`loadLiveAuthPayload`): a run the system started (`startedById` NULL,
 * #1528, or the system actor), a deactivated or deleted user, and a failed
 * lookup all promote as draft. Fails closed, never throws.
 */
export async function signOffForUser(userId: string | null | undefined): Promise<PromotionSignOff> {
  if (!userId || userId === SYSTEM_ACTOR_ID) return { asApproved: false };
  try {
    const live = await loadLiveAuthPayload(userId);
    return { asApproved: live?.permissions.includes(REQUIREMENT_SIGN_OFF_PERMISSION) ?? false };
  } catch (err) {
    log.warn("could not read the promoter's permissions; promoting as draft", {
      userId,
      error: (err as Error).message,
    });
    return { asApproved: false };
  }
}

/**
 * Sign-off for the user who started an analysis (`Analysis.startedById`), read
 * from the row so a continuation or regenerate uses the run's own starter.
 * Fails closed like {@link signOffForUser}: a missing row or a failed read
 * promotes as draft.
 */
export async function signOffForAnalysisStarter(analysisId: string): Promise<PromotionSignOff> {
  let startedById: string | null | undefined;
  try {
    const row = await prisma.analysis.findFirst({
      where: { id: analysisId },
      select: { startedById: true },
    });
    startedById = row?.startedById;
  } catch (err) {
    log.warn("could not read the run's starter; promoting as draft", {
      analysisId,
      error: (err as Error).message,
    });
    return { asApproved: false };
  }
  return signOffForUser(startedById);
}
