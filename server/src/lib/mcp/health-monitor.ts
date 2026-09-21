/**
 * MCP health monitor — periodically pings each `ready` server and persists
 * status updates back to the database. Failed pings increment the failure
 * counter; three consecutive failures flip the row to `error` and trigger a
 * lifecycle restart attempt.
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import type { MCPLifecycleManager } from "./lifecycle-manager.js";

const log = createChildLogger("mcp-health");

const FAILURE_THRESHOLD = 3;
const TICK_INTERVAL_MS = 10_000; // outer tick — actual interval respects each server's setting

export interface HealthMonitorOptions {
  intervalMs?: number;
  /** Test seam — replace setInterval with a manual driver. */
  scheduler?: {
    setInterval(cb: () => void, ms: number): NodeJS.Timeout | number;
    clearInterval(handle: NodeJS.Timeout | number): void;
  };
  /** Test seam. */
  now?: () => number;
}

export class MCPHealthMonitor {
  private handle: NodeJS.Timeout | number | null = null;
  private readonly tickMs: number;
  private readonly scheduler: NonNullable<HealthMonitorOptions["scheduler"]>;
  private readonly nowFn: () => number;

  constructor(
    private readonly lifecycle: MCPLifecycleManager,
    opts: HealthMonitorOptions = {},
  ) {
    this.tickMs = opts.intervalMs ?? TICK_INTERVAL_MS;
    this.scheduler = opts.scheduler ?? {
      setInterval: (cb, ms) => setInterval(cb, ms),
      clearInterval: (h) => clearInterval(h as NodeJS.Timeout),
    };
    this.nowFn = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.handle) return;
    const handle = this.scheduler.setInterval(() => {
      void this.tick().catch((err) => log.warn("MCP health tick failed", { error: err.message }));
    }, this.tickMs);
    if (handle && typeof (handle as NodeJS.Timeout).unref === "function") {
      (handle as NodeJS.Timeout).unref();
    }
    this.handle = handle;
  }

  stop(): void {
    if (this.handle) {
      this.scheduler.clearInterval(this.handle);
      this.handle = null;
    }
  }

  /** Run a single tick — exposed for tests. */
  async tick(): Promise<void> {
    const now = this.nowFn();
    const snapshots = this.lifecycle.list();
    for (const { config, state } of snapshots) {
      if (!config.enabled) continue;
      if (state.status !== "ready" && state.status !== "error") continue;
      const dueAt =
        (state.lastHealthCheckAt?.getTime() ?? 0) + config.healthCheckIntervalSec * 1000;
      if (now < dueAt) continue;

      const probe = await this.lifecycle.probe(config.id);
      const updated = this.lifecycle.get(config.id);
      if (!updated) continue;
      try {
        await prisma.mCPServer.update({
          where: { id: config.id },
          data: {
            status: updated.state.status,
            lastError: updated.state.lastError,
            latencyMs: updated.state.latencyMs,
            failureCount: updated.state.failureCount,
            lastHealthCheckAt: updated.state.lastHealthCheckAt,
          },
        });
      } catch (err) {
        log.warn("MCP health update DB write failed", {
          serverId: config.id,
          error: (err as Error).message,
        });
      }
      if (!probe.ok && updated.state.failureCount >= FAILURE_THRESHOLD) {
        log.warn("MCP server marked red after consecutive failures", {
          serverId: config.id,
          failures: updated.state.failureCount,
        });
      }
    }
  }
}
