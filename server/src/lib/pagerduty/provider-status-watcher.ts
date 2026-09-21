/**
 * Issue #580 (epic #63) — MCP provider/sandbox status → PagerDuty sev-1 watcher.
 *
 * Subscribes to MCP lifecycle status events (via `lifecycle.onStatus(...)`) and:
 *   - on the EDGE into `error` → fires {@link pagerDutyProviderDown} (trigger),
 *   - on the edge `error → ready` → fires {@link pagerDutyProviderRecovered} (resolve).
 *
 * EDGE (not level) detection: the watcher remembers the last status it saw per
 * serverId, so a server that stays down across many health ticks produces exactly
 * ONE incident (the PagerDuty dedup key `metis:provider-down:<serverId>` collapses
 * repeats anyway, but edge-detection avoids needless API calls). The matching
 * resolve fires once the same server flips back to `ready`.
 *
 * WORKSPACE RESOLUTION:
 *   - `project`-scoped servers derive the owning workspace from their project.
 *   - `global`/`user`-scoped servers (no project) fall back to the ops workspace
 *     (`PAGERDUTY_OPS_WORKSPACE_ID`); when that is unset, the event is a no-op.
 *
 * NON-THROWING: the watcher swallows all errors so a status event can never break
 * the lifecycle manager's emit loop.
 */
import type { PrismaClient } from "@prisma/client";

import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import type { MCPStatusEvent } from "../mcp/types.js";
import { opsWorkspaceId } from "./ops-workspace.js";
import { pagerDutyProviderDown, pagerDutyProviderRecovered } from "./alerting-hooks.js";

const log = createChildLogger("pagerduty-provider-watcher");

type DownHook = typeof pagerDutyProviderDown;
type RecoveredHook = typeof pagerDutyProviderRecovered;

export interface ProviderStatusWatcherDeps {
  db?: PrismaClient;
  /** Injectable hooks for tests. */
  down?: (input: {
    workspaceId: string;
    serverId: string;
    label: string;
    lastError: string;
  }) => Promise<void>;
  recovered?: (input: { workspaceId: string; serverId: string }) => Promise<void>;
}

export class PagerDutyProviderStatusWatcher {
  private readonly db: PrismaClient;
  private readonly down: NonNullable<ProviderStatusWatcherDeps["down"]>;
  private readonly recovered: NonNullable<ProviderStatusWatcherDeps["recovered"]>;
  /** Last status seen per serverId (for edge detection). */
  private readonly lastStatus = new Map<string, MCPStatusEvent["status"]>();

  constructor(deps: ProviderStatusWatcherDeps = {}) {
    this.db = deps.db ?? defaultPrisma;
    this.down = deps.down ?? ((input) => (pagerDutyProviderDown as DownHook)(input));
    this.recovered =
      deps.recovered ?? ((input) => (pagerDutyProviderRecovered as RecoveredHook)(input));
  }

  /** Handle one lifecycle status event. Safe to register via `lifecycle.onStatus`. */
  async onStatus(event: MCPStatusEvent): Promise<void> {
    const prev = this.lastStatus.get(event.serverId);
    this.lastStatus.set(event.serverId, event.status);

    try {
      // Edge into error → trigger.
      if (event.status === "error" && prev !== "error") {
        const workspaceId = await this.resolveWorkspace(event);
        if (!workspaceId) return;
        await this.down({
          workspaceId,
          serverId: event.serverId,
          label: event.label,
          lastError: event.lastError ?? "unknown error",
        });
        return;
      }
      // Edge error → ready → resolve.
      if (event.status === "ready" && prev === "error") {
        const workspaceId = await this.resolveWorkspace(event);
        if (!workspaceId) return;
        await this.recovered({ workspaceId, serverId: event.serverId });
      }
    } catch (err) {
      log.warn("provider status watcher failed (swallowed)", {
        serverId: event.serverId,
        status: event.status,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Resolve the workspace to page: a project-scoped server's project workspace, or
   * the ops workspace for global/user-scoped servers. null → no-op.
   */
  private async resolveWorkspace(event: MCPStatusEvent): Promise<string | null> {
    if (event.scope === "project" && event.projectId) {
      const project = await this.db.project.findFirst({
        where: { id: event.projectId },
        select: { workspaceId: true },
      });
      if (project?.workspaceId) return project.workspaceId;
      // A project with no workspace falls through to the ops workspace.
    }
    return opsWorkspaceId();
  }
}
