/**
 * Issue #277 — Idle reaper for user-scoped MCP servers.
 *
 * Periodically (default every 5 minutes) inspects all enabled, user-scoped
 * MCP rows whose `lastToolInvocationAt` is older than the configured
 * `MCP_USER_IDLE_TIMEOUT_MIN`. Each match is stopped via the lifecycle
 * manager and its enabled flag flipped to `false`.
 *
 * The reaper is a no-op when `MCP_ALLOW_USER_SCOPE=false`.
 */
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { auditMcpEvent } from "../audit/mcp-audit.js";
import type { MCPLifecycleManager } from "./lifecycle-manager.js";

const log = createChildLogger("mcp-idle-reaper");

export interface IdleReaperOptions {
  /** How often to sweep — defaults to 5 minutes. */
  intervalMs?: number;
  /** Test seam: clock + sleeper. */
  now?: () => Date;
}

export class MCPIdleReaper {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private running = false;

  constructor(
    private readonly lifecycle: MCPLifecycleManager,
    opts: IdleReaperOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        log.warn("Idle reaper sweep failed", { error: (err as Error).message });
      });
    }, this.intervalMs);
    // Don't keep the event loop alive solely for the reaper.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run a single sweep. Public for tests. */
  async sweep(): Promise<{ stopped: number; skipped: number }> {
    if (this.running) return { stopped: 0, skipped: 0 };
    this.running = true;
    try {
      const cfg = getConfigService();
      if (!cfg.getBool("MCP_ALLOW_USER_SCOPE", false)) return { stopped: 0, skipped: 0 };
      const idleMin = cfg.getNumber("MCP_USER_IDLE_TIMEOUT_MIN", 30);
      const cutoff = new Date(this.now().getTime() - idleMin * 60 * 1000);
      const rows = await prisma.mCPServer.findMany({
        where: {
          scope: "user",
          enabled: true,
          deletedAt: null,
          status: "ready",
        },
      });
      let stopped = 0;
      let skipped = 0;
      for (const row of rows) {
        const lastActive = (row as { lastToolInvocationAt?: Date | null }).lastToolInvocationAt;
        // Use createdAt as the floor when no invocation has been recorded.
        const activityAt = lastActive ?? row.createdAt;
        if (activityAt > cutoff) {
          skipped += 1;
          continue;
        }
        try {
          await this.lifecycle.stop(row.id, "idle-reaper");
          await prisma.mCPServer.update({
            where: { id: row.id },
            data: { status: "idle", capabilities: null, enabled: false },
          });
          auditMcpEvent("mcp.stopped", {
            mcpId: row.id,
            name: row.label,
            scope: row.scope,
            transport: row.transport,
            actor: { type: "system", id: null },
            command: row.command,
            argsCount: 0,
            envKeys: [],
            extra: { reason: "idle-reaper", idleMin },
          });
          stopped += 1;
        } catch (err) {
          log.warn("Failed to reap idle MCP", { id: row.id, error: (err as Error).message });
        }
      }
      if (stopped > 0) log.info("Reaped idle user-scoped MCPs", { stopped, skipped });
      return { stopped, skipped };
    } finally {
      this.running = false;
    }
  }
}
