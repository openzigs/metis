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

/**
 * Analysis metadata key recording the status the checkpoint promotion wrote
 * its rows with (`"approved"` | `"draft"`). A later re-save of the reviewed set
 * (regenerate, resume) carries it over, so it can narrow the sign-off but never
 * widen it (#1589 review).
 */
export const CHECKPOINT_SIGN_OFF_KEY = "checkpointSignOff";

/** How a checkpoint promotion records the rows it writes. */
export interface PromotionSignOff {
  /** `true`: the rows are written `approved`; `false`: `draft`. */
  asApproved: boolean;
}

/** The review status a checkpoint promotion writes its rows with. */
export function promotedReviewStatus(signOff: PromotionSignOff): "approved" | "draft" {
  return signOff.asApproved ? "approved" : "draft";
}

/**
 * Sign-off for a request's caller, from the role the permission middleware read.
 * That is the token's role claim, as `requirePermission` judges it, so a user
 * demoted since sign-in keeps the old answer until the token expires; the
 * paths that read durable roles ({@link signOffForUser}) answer `draft` for
 * them at once. The routes deliberately match the permission check they sit
 * behind rather than disagree with it.
 */
export function signOffForRole(role: RoleKey): PromotionSignOff {
  return { asApproved: hasPermission(role, REQUIREMENT_SIGN_OFF_PERMISSION) };
}

/**
 * Sign-off for a user who is not the request's caller — the trigger of a re-save
 * the orchestrator makes, or whoever asked for drafts. Read from durable
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
 * Sign-off for the orchestrator re-saving a reviewed requirement set (a
 * regenerate or a resume). Both must hold, so a re-save never records
 * `approved` against someone who did not sign off:
 *
 * - the sign-off recorded when the set was promoted
 *   ({@link CHECKPOINT_SIGN_OFF_KEY}) — a set promoted as `draft` stays draft;
 * - the user who triggered the re-save (`actorId`), or the run's starter when
 *   there is none (the pipeline's own synthesis).
 *
 * Read from durable state; fails closed like {@link signOffForUser}.
 */
export async function signOffForResave(
  analysisId: string,
  actorId?: string,
): Promise<PromotionSignOff> {
  let startedById: string | null | undefined;
  let recorded: unknown;
  try {
    const row = await prisma.analysis.findFirst({
      where: { id: analysisId },
      select: { startedById: true, metadata: true },
    });
    startedById = row?.startedById;
    if (row?.metadata) {
      recorded = (JSON.parse(row.metadata) as Record<string, unknown>)[CHECKPOINT_SIGN_OFF_KEY];
    }
  } catch (err) {
    log.warn("could not read the run's sign-off record; promoting as draft", {
      analysisId,
      error: (err as Error).message,
    });
    return { asApproved: false };
  }
  if (recorded === "draft") return { asApproved: false };
  return signOffForUser(actorId ?? startedById);
}
