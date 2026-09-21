/**
 * Issue #580 (epic #63) — thin, best-effort hooks the three sev-1 sources call to
 * fire a PagerDuty incident.
 *
 * Each hook:
 *   1. Derives the owning `workspaceId` (from a project where the source only has
 *      a projectId; directly where the workspace is already in scope). A missing
 *      workspace is a silent no-op.
 *   2. Delegates to a {@link PagerDutyAlerter} (lazy singleton by default,
 *      injectable for tests). The alerter is itself non-throwing; the extra
 *      try/catch here guards the synchronous workspace-derivation step too.
 *
 * Deliberately THIN and NON-THROWING so an emission point can call them on its
 * critical path without risk — exactly the #67 `notification-hooks.ts` contract.
 * These are the import seam the publisher / vault route / MCP bootstrap wire to.
 *
 * NOTIFICATION-PREFERENCE EXEMPTION (#614) — EXEMPT BY DESIGN.
 * Every hook in this module is a sev-1 ops severity path (publish rollback,
 * vault rotation failure, provider down/recovered). These pages go to an
 * on-call rotation, NOT to a METIS user, and must NEVER be suppressible by a
 * per-user notification preference — a wrongly-applied preference here would
 * silently drop sev-1 pages. Do NOT add `shouldNotify` calls to this module.
 * The exemption is enumerated in NOTIFICATION_PREFERENCE_EXEMPTIONS
 * ("pagerduty-ops-alerting") in ../notifications/preferences.ts and documented
 * in docs/ARCHITECTURE.md.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { PagerDutyAlerter } from "./alerting.js";
import { PagerDutyEventsClient } from "./events-client.js";
import { getPagerDutyServiceConfigStore } from "./service-config-store.js";

const log = createChildLogger("pagerduty-hooks");

// ── default alerter singleton ────────────────────────────────────────────────

let alerterSingleton: PagerDutyAlerter | null = null;
function defaultAlerter(): PagerDutyAlerter {
  if (!alerterSingleton) {
    alerterSingleton = new PagerDutyAlerter({
      client: new PagerDutyEventsClient(),
      configStore: getPagerDutyServiceConfigStore(),
    });
  }
  return alerterSingleton;
}

/** Test helper — reset the alerter singleton. */
export function __resetPagerDutyAlerter(): void {
  alerterSingleton = null;
}

interface HookDeps {
  alerter: PagerDutyAlerter;
  db: PrismaClient;
}

/** Resolve `(projectName, workspaceId)` for a project; null when not resolvable. */
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

// ── publish rollback (publisher.ts auto-rollback path) ────────────────────────

export async function pagerDutyPublishRollback(
  input: { batchId: string; projectId: string; reason: string; repo?: string | null },
  overrides: Partial<HookDeps> = {},
): Promise<void> {
  const db = overrides.db ?? defaultPrisma;
  const alerter = overrides.alerter ?? defaultAlerter();
  try {
    const ws = await resolveProjectWorkspace(db, input.projectId);
    if (!ws) return;
    await alerter.publishRollback({
      workspaceId: ws.workspaceId,
      projectId: input.projectId,
      projectName: ws.projectName,
      batchId: input.batchId,
      reason: input.reason,
      repo: input.repo ?? null,
    });
  } catch (err) {
    log.warn("publish-rollback PagerDuty hook failed", {
      batchId: input.batchId,
      error: (err as Error).message,
    });
  }
}

// ── vault key rotation failure (vault.ts rotate route) ────────────────────────

export async function pagerDutyVaultRotationFailure(
  input: { workspaceId: string; secretId: string; label: string; reason: string },
  overrides: Partial<HookDeps> = {},
): Promise<void> {
  const alerter = overrides.alerter ?? defaultAlerter();
  try {
    if (!input.workspaceId || input.workspaceId.trim().length === 0) return;
    await alerter.vaultRotationFailure({
      workspaceId: input.workspaceId,
      secretId: input.secretId,
      label: input.label,
      reason: input.reason,
    });
  } catch (err) {
    log.warn("vault-rotation-failure PagerDuty hook failed", {
      secretId: input.secretId,
      error: (err as Error).message,
    });
  }
}

// ── provider/sandbox down + recovery (MCP lifecycle status) ───────────────────

export async function pagerDutyProviderDown(
  input: { workspaceId: string; serverId: string; label: string; lastError: string },
  overrides: Partial<HookDeps> = {},
): Promise<void> {
  const alerter = overrides.alerter ?? defaultAlerter();
  try {
    if (!input.workspaceId || input.workspaceId.trim().length === 0) return;
    await alerter.providerDown({
      workspaceId: input.workspaceId,
      serverId: input.serverId,
      label: input.label,
      lastError: input.lastError,
    });
  } catch (err) {
    log.warn("provider-down PagerDuty hook failed", {
      serverId: input.serverId,
      error: (err as Error).message,
    });
  }
}

export async function pagerDutyProviderRecovered(
  input: { workspaceId: string; serverId: string },
  overrides: Partial<HookDeps> = {},
): Promise<void> {
  const alerter = overrides.alerter ?? defaultAlerter();
  try {
    if (!input.workspaceId || input.workspaceId.trim().length === 0) return;
    await alerter.providerRecovered({
      workspaceId: input.workspaceId,
      serverId: input.serverId,
    });
  } catch (err) {
    log.warn("provider-recovered PagerDuty hook failed", {
      serverId: input.serverId,
      error: (err as Error).message,
    });
  }
}
