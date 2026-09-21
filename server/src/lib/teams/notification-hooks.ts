/**
 * Issue #67 — thin, best-effort hooks that the three operational event sources
 * call to fire a one-way Teams notification card.
 *
 * Each hook:
 *   1. Derives the owning `workspaceId` from the event's domain object (a project
 *      → workspace, or directly from a workspace tick). A missing workspace is a
 *      silent no-op (e.g. a project not yet assigned to a workspace).
 *   2. Renders the appropriate notification card (notification-render.ts).
 *   3. Schedules a fire-and-forget proactive send (notification-sync.ts).
 *
 * The hooks are deliberately THIN and NON-THROWING so an emission point can call
 * them on its critical path without risk: an analysis-complete / publish-rollback
 * / budget tick must succeed even if Teams notification fails or is unconfigured.
 * `scheduleEventNotification` is itself fire-and-forget; the extra try/catch here
 * guards the synchronous render + workspace-derivation step too.
 *
 * Workspace derivation uses the SHARED Prisma client (project → workspaceId),
 * exactly as the #550 outbound mirror derives a workspace from a thread's
 * project. Each hook accepts an injectable Prisma + scheduler so it is
 * unit-testable without a real DB or network.
 *
 * NOTIFICATION PREFERENCES (#614): when a card targets ONE identifiable METIS
 * user (`targetUserId`), that user's `teams × <event>` preference is enforced
 * via `shouldNotify` (fail-open). Cards WITHOUT a target user are workspace
 * broadcasts and are preference-EXEMPT — as are ALL budget-exceeded cards
 * (workspace-level ops alerts). See NOTIFICATION_PREFERENCE_EXEMPTIONS
 * ("teams-workspace-broadcast-cards") in ../notifications/preferences.ts.
 */
import type { PrismaClient } from "@prisma/client";
import type { Activity } from "botbuilder";

import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { shouldNotify } from "../notifications/preferences.js";
import {
  renderAnalysisCompleteCard,
  renderPublishRolledBackCard,
  renderBudgetExceededCard,
  type BudgetExceededPayload,
} from "./notification-render.js";
import { scheduleEventNotification } from "./notification-sync.js";

const log = createChildLogger("teams-notification-hooks");

export const EVENT_ANALYSIS_COMPLETE = "analysis-complete";
export const EVENT_PUBLISH_ROLLED_BACK = "publish-rolled-back";
export const EVENT_BUDGET_EXCEEDED = "budget-exceeded";

/** Scheduler seam — injectable so hooks can be unit-tested without a network. */
export type NotificationScheduler = (
  workspaceId: string,
  eventType: string,
  activity: Partial<Activity>,
) => void;

export interface HookDeps {
  db: PrismaClient;
  schedule: NotificationScheduler;
}

function defaultDeps(): HookDeps {
  return { db: defaultPrisma, schedule: scheduleEventNotification };
}

/** Resolve `(projectName, workspaceId)` for a project; nulls when not resolvable. */
async function resolveProjectWorkspace(
  db: PrismaClient,
  projectId: string,
): Promise<{ projectName: string; workspaceId: string } | null> {
  const project = await db.project.findFirst({
    where: { id: projectId },
    select: { name: true, workspaceId: true },
  });
  if (!project || !project.workspaceId) return null;
  return { projectName: project.name, workspaceId: project.workspaceId };
}

/**
 * Fire the analysis-complete notification. Best-effort/non-throwing — safe to
 * call from {@link markAnalysisCompleted}. Optional counts ride into the card.
 */
export async function notifyAnalysisComplete(
  input: {
    analysisId: string;
    projectId: string;
    requirementCount?: number | null;
    findingCount?: number | null;
    /**
     * #614 — set when this card targets ONE identifiable METIS user, whose
     * `teams × analysisCompleted` preference is then enforced. Absent/null =
     * workspace broadcast (preference-exempt by policy).
     */
    targetUserId?: string | null;
  },
  overrides: Partial<HookDeps> = {},
): Promise<void> {
  const deps: HookDeps = { ...defaultDeps(), ...overrides };
  try {
    // shouldNotify never throws (fail-open: send); suppression is debug-logged.
    if (
      input.targetUserId &&
      !(await shouldNotify(input.targetUserId, "teams", "analysisCompleted"))
    ) {
      return;
    }
    const ws = await resolveProjectWorkspace(deps.db, input.projectId);
    if (!ws) return;
    const activity = renderAnalysisCompleteCard({
      projectName: ws.projectName,
      analysisId: input.analysisId,
      requirementCount: input.requirementCount ?? null,
      findingCount: input.findingCount ?? null,
    });
    deps.schedule(ws.workspaceId, EVENT_ANALYSIS_COMPLETE, activity);
  } catch (err) {
    log.warn("analysis-complete notification hook failed", {
      analysisId: input.analysisId,
      error: (err as Error).message,
    });
  }
}

/**
 * Fire the publish-rolled-back notification. Best-effort/non-throwing — safe to
 * call from the publishing rollback path.
 */
export async function notifyPublishRolledBack(
  input: {
    batchId: string;
    projectId: string;
    reason: string;
    repo?: string | null;
    /**
     * #614 — set when this card targets ONE identifiable METIS user, whose
     * `teams × issuesPublished` preference is then enforced (a rollback is
     * part of the issue-publish lifecycle). Absent/null = workspace broadcast
     * (preference-exempt by policy).
     */
    targetUserId?: string | null;
  },
  overrides: Partial<HookDeps> = {},
): Promise<void> {
  const deps: HookDeps = { ...defaultDeps(), ...overrides };
  try {
    // shouldNotify never throws (fail-open: send); suppression is debug-logged.
    if (
      input.targetUserId &&
      !(await shouldNotify(input.targetUserId, "teams", "issuesPublished"))
    ) {
      return;
    }
    const ws = await resolveProjectWorkspace(deps.db, input.projectId);
    if (!ws) return;
    const activity = renderPublishRolledBackCard({
      projectName: ws.projectName,
      batchId: input.batchId,
      reason: input.reason,
      repo: input.repo ?? null,
    });
    deps.schedule(ws.workspaceId, EVENT_PUBLISH_ROLLED_BACK, activity);
  } catch (err) {
    log.warn("publish-rolled-back notification hook failed", {
      batchId: input.batchId,
      error: (err as Error).message,
    });
  }
}

/**
 * Fire the budget-exceeded notification. Best-effort/non-throwing — safe to call
 * from the FinOps alert engine after a rule fires. The workspace is the event's
 * own subject (no project derivation needed).
 *
 * #614 — EXEMPT BY DESIGN from per-user notification preferences: budget cards
 * are workspace-level budget alerts (ops-critical) addressed to a workspace
 * conversation, never to an individual user, so no user preference may
 * suppress them. Do NOT add a `shouldNotify` call here. See
 * NOTIFICATION_PREFERENCE_EXEMPTIONS ("teams-workspace-broadcast-cards").
 */
export function notifyBudgetExceeded(
  workspaceId: string,
  payload: BudgetExceededPayload,
  overrides: Partial<HookDeps> = {},
): void {
  const deps: HookDeps = { ...defaultDeps(), ...overrides };
  try {
    if (!workspaceId) return;
    const activity = renderBudgetExceededCard(payload);
    deps.schedule(workspaceId, EVENT_BUDGET_EXCEEDED, activity);
  } catch (err) {
    log.warn("budget-exceeded notification hook failed", {
      workspaceId,
      error: (err as Error).message,
    });
  }
}
