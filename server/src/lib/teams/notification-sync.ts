/**
 * Issue #67 — proactively send a ONE-WAY Teams notification card for an
 * operational event (analysis-complete | publish-rolled-back | budget-exceeded).
 *
 * Reuses the #550 proactive-send mechanism end-to-end: resolve the workspace's
 * vaulted bot credentials (#548), build a `CloudAdapter`, and send the rendered
 * Adaptive Card via `continueConversationAsync(botAppId, ref, logic)` against the
 * stored `ConversationReference` of the workspace's registered notification
 * target. The ONLY differences from #550 are the lookup (a per-event
 * notification TARGET, not a per-thread channel LINK) and the card (a one-way
 * notification, not a discussion mirror) — auth, adapter, and the proactive API
 * are identical.
 *
 * DESIGN GUARANTEES
 *
 * 1. BEST-EFFORT / NON-THROWING. A notification send must NEVER break the
 *    originating operation (an analysis run, a publish rollback, a budget tick).
 *    The orchestrator catches and logs everything; it returns a small result
 *    object and never rejects. Callers fire it via {@link scheduleEventNotification}
 *    (fire-and-forget) off the operation's critical path.
 *
 * 2. ZERO-OVERHEAD WHEN UNCONFIGURED. The first thing we do is look up a target
 *    for `(workspaceId, eventType)`. No target → immediate no-op: no credential
 *    resolution, no adapter construction, no network. Most workspaces will not
 *    have a Teams target for every event, so the hot path stays free.
 *
 * 3. TENANT ALLOWLIST (#554). Before sending, we assert the target channel's
 *    tenant is permitted by the configured `TEAMS_ALLOWED_TENANTS` policy. A
 *    validly-stored target in a non-allowlisted tenant is NOT sent — defence in
 *    depth so a notification can never be proactively pushed into a tenant the
 *    operator has not approved.
 *
 * 4. WORKSPACE ISOLATION. Every lookup is keyed by `workspaceId`; the credentials
 *    and the destination reference both come from that same workspace. A
 *    notification can never be delivered to another workspace's channel, and no
 *    cross-workspace data is read (the caller supplies the rendered card from the
 *    originating workspace's own event).
 *
 * Every collaborator is injectable so the orchestration is unit-testable with
 * stubs — no live Azure tenant, no real Prisma, no real network.
 */
import type { Activity, ConversationReference, TurnContext } from "botbuilder";

import { createChildLogger } from "../logger.js";
import { getBotAdapterFactory, type BotAdapterFactory } from "./bot-adapter.js";
import {
  getTeamsInstallationStore,
  type ResolvedCredentials,
  type TeamsInstallationStore,
} from "./installation-store.js";
import {
  getTeamsNotificationTargetStore,
  type ResolvedNotificationTarget,
  type TeamsNotificationTargetStore,
} from "./notification-target-store.js";
import {
  loadTeamsTenantAllowlist,
  isTeamsTenantAllowed,
  type TeamsTenantPolicy,
} from "./tenant-allowlist.js";

const log = createChildLogger("teams-notification");

/** Minimal adapter surface for a proactive send (matches outbound-sync). */
export interface ProactiveAdapterLike {
  continueConversationAsync(
    botAppId: string,
    reference: Partial<ConversationReference>,
    logic: (context: TurnContext) => Promise<void>,
  ): Promise<void>;
}

/** Injectable collaborators (defaults wire the real singletons/factories). */
export interface NotificationSyncDeps {
  targetStore: TeamsNotificationTargetStore;
  installStore: TeamsInstallationStore;
  adapterFactory: BotAdapterFactory;
  /** The tenant policy (defaults to the env-derived allowlist). */
  tenantPolicy: TeamsTenantPolicy;
}

function defaultDeps(): NotificationSyncDeps {
  return {
    targetStore: getTeamsNotificationTargetStore(),
    installStore: getTeamsInstallationStore(),
    adapterFactory: getBotAdapterFactory(),
    tenantPolicy: loadTeamsTenantAllowlist(),
  };
}

/** Outcome of a notification attempt (for tests + structured logs). */
export interface NotificationResult {
  sent: boolean;
  reason?: "no-target" | "tenant-not-allowed" | "no-installation" | "adapter-unsupported" | "error";
}

/** Send a single proactive activity to the target channel. Throws on failure. */
async function sendProactive(
  deps: NotificationSyncDeps,
  workspaceId: string,
  target: ResolvedNotificationTarget,
  activity: Partial<Activity>,
): Promise<void> {
  const creds: ResolvedCredentials | null = await deps.installStore.resolveAppPassword(workspaceId);
  if (!creds) {
    throw new Error(`no active Teams installation for workspace ${workspaceId}`);
  }

  const adapter = deps.adapterFactory(creds) as unknown as ProactiveAdapterLike;
  if (typeof adapter.continueConversationAsync !== "function") {
    throw new Error("adapter does not support continueConversationAsync (proactive send)");
  }

  await adapter.continueConversationAsync(creds.appId, target.reference, async (context) => {
    await context.sendActivity(activity);
  });
}

/**
 * Proactively send a notification card for `eventType` to the workspace's
 * registered Teams channel. BEST-EFFORT and NON-THROWING. Returns a result
 * describing what happened; never rejects.
 *
 * @param activity the rendered notification activity (from notification-render).
 */
export async function sendEventNotification(
  workspaceId: string,
  eventType: string,
  activity: Partial<Activity>,
  overrides: Partial<NotificationSyncDeps> = {},
): Promise<NotificationResult> {
  const deps: NotificationSyncDeps = { ...defaultDeps(), ...overrides };

  try {
    if (!workspaceId) return { sent: false, reason: "no-target" };

    // 2. ZERO-OVERHEAD WHEN UNCONFIGURED — bail before any credential/network work.
    const target = await deps.targetStore.getByEvent(workspaceId, eventType);
    if (!target) {
      return { sent: false, reason: "no-target" };
    }

    // 3. TENANT ALLOWLIST (#554) — never push into a non-approved tenant.
    if (!isTeamsTenantAllowed(deps.tenantPolicy, target.tenantId)) {
      log.warn("Teams notification suppressed — tenant not allowed", { workspaceId, eventType });
      return { sent: false, reason: "tenant-not-allowed" };
    }

    await sendProactive(deps, workspaceId, target, activity);
    return { sent: true };
  } catch (err) {
    // 1. BEST-EFFORT — swallow + log. The originating operation is unaffected.
    log.warn("Teams notification send failed", {
      workspaceId,
      eventType,
      error: (err as Error).message,
    });
    return { sent: false, reason: "error" };
  }
}

/**
 * Fire-and-forget wrapper for an operation's critical path. Schedules the send
 * and returns immediately; any rejection (there should be none —
 * {@link sendEventNotification} never rejects) is caught so an unhandled promise
 * rejection can never surface and break the originating operation.
 */
export function scheduleEventNotification(
  workspaceId: string,
  eventType: string,
  activity: Partial<Activity>,
): void {
  void sendEventNotification(workspaceId, eventType, activity).catch((err) => {
    log.warn("Teams notification scheduling error", {
      workspaceId,
      eventType,
      error: (err as Error).message,
    });
  });
}
