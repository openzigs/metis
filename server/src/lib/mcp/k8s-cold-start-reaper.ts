/**
 * Epic #272 / Sub-issue #290 — Cold-start idle reaper for k8s-sse Deployments.
 *
 * For MCP servers with `runtime='k8s-sse'` and `coldStart=true`:
 *   - Inactivity beyond `MCP_COLD_START_IDLE_MIN` minutes scales the
 *     Deployment to `replicas: 0`. The Service stays so the next tool call
 *     can re-scale to 1 without a full re-provision.
 *   - The lifecycle entry stays in 'idle' status; the next `invokeTool()`
 *     triggers wake-up via `wakeColdStarted()`.
 *
 * Native and docker-stdio runtimes are ignored. Cold-start is opt-in per
 * server.
 */
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import type { MCPLifecycleManager } from "./lifecycle-manager.js";
import type { K8sApis } from "./provisioners/k8s-sse.js";
import { buildResourceName } from "./provisioners/k8s-sse.js";

const log = createChildLogger("mcp-cold-start-reaper");

export interface ColdStartReaperOptions {
  /** Sweep interval — defaults to 5 minutes. */
  intervalMs?: number;
  /** Test seam — clock. */
  now?: () => Date;
  /** Inject K8s APIs (test). When omitted, the reaper resolves them via `apisProvider`. */
  apis?: K8sApis;
  /**
   * Lazy provider for K8s APIs — invoked on every sweep so the reaper
   * can keep running even when kubeconfig isn't available at construction
   * time (local dev). Returning null skips the sweep silently.
   */
  apisProvider?: () => K8sApis | null;
  /** Override namespace lookup for tests; defaults to MCP_K8S_NAMESPACE. */
  namespace?: string;
}

/** Minimal type for the row fields the reaper consumes. */
interface ReapableRow {
  id: string;
  label: string;
  runtime?: string | null;
  coldStart?: boolean | null;
  status: string;
  enabled: boolean;
  lastToolInvocationAt?: Date | null;
  createdAt: Date;
}

export class K8sColdStartReaper {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly apis: K8sApis | null;
  private readonly apisProvider: (() => K8sApis | null) | null;
  private readonly nsOverride: string | null;
  private running = false;

  constructor(_lifecycle: MCPLifecycleManager, opts: ColdStartReaperOptions = {}) {
    void _lifecycle; // Reserved for future per-server eviction notifications.
    this.intervalMs = opts.intervalMs ?? 5 * 60 * 1000;
    this.now = opts.now ?? (() => new Date());
    this.apis = opts.apis ?? null;
    this.apisProvider = opts.apisProvider ?? null;
    this.nsOverride = opts.namespace ?? null;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep().catch((err) => {
        log.warn("Cold-start reaper sweep failed", { error: (err as Error).message });
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single sweep. Returns counts for tests/observability. Public so
   * tests can call it without waiting for the interval.
   */
  async sweep(): Promise<{ scaled: number; skipped: number }> {
    if (this.running) return { scaled: 0, skipped: 0 };
    const apis = this.apis ?? this.apisProvider?.() ?? null;
    if (!apis) {
      // Without APIs we have no way to scale — either inject `apis`/`apisProvider`
      // at construction time or accept the no-op (e.g. local dev w/o kubeconfig).
      return { scaled: 0, skipped: 0 };
    }
    this.running = true;
    try {
      const cfg = getConfigService();
      const idleMin = cfg.getNumber("MCP_COLD_START_IDLE_MIN", 10);
      const namespace = this.nsOverride ?? cfg.get("MCP_K8S_NAMESPACE")?.trim() ?? "metis-mcp";
      const cutoff = new Date(this.now().getTime() - idleMin * 60 * 1000);
      const rows = (await prisma.mCPServer.findMany({
        where: {
          enabled: true,
          deletedAt: null,
        },
      })) as unknown as ReapableRow[];
      let scaled = 0;
      let skipped = 0;
      for (const row of rows) {
        if (row.runtime !== "k8s-sse" || !row.coldStart) {
          skipped += 1;
          continue;
        }
        if (row.status !== "ready") {
          skipped += 1;
          continue;
        }
        const lastActive = row.lastToolInvocationAt ?? row.createdAt;
        if (lastActive > cutoff) {
          skipped += 1;
          continue;
        }
        try {
          await scaleDeployment(apis, namespace, buildResourceName(row.id), 0);
          await prisma.mCPServer.update({
            where: { id: row.id },
            data: { status: "idle" },
          });
          scaled += 1;
        } catch (err) {
          log.warn("Cold-start scale-down failed", {
            id: row.id,
            error: (err as Error).message,
          });
        }
      }
      if (scaled > 0) {
        log.info("Cold-start scale-down completed", { scaled, skipped, idleMin });
      }
      return { scaled, skipped };
    } finally {
      this.running = false;
    }
  }
}

/**
 * Scale a Deployment's replica count via a JSON-merge patch. Used by both
 * the reaper (down to 0) and the pre-tool-call wake-up (up to 1).
 */
export async function scaleDeployment(
  apis: K8sApis,
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  await apis.apps.patchNamespacedDeployment({
    name,
    namespace,
    body: { spec: { replicas } },
  } as unknown as Parameters<K8sApis["apps"]["patchNamespacedDeployment"]>[0]);
}

export interface WakeColdStartedOptions {
  apis: K8sApis;
  namespace?: string;
  /** Max ms to wait for ready after scale-up. Defaults to MCP_K8S_PROVISION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Test seam — clock + sleep. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wake hook intended to be passed as `MCPToolBridgeOptions.coldStartWakeup`.
 *
 * Pulls the row, decides whether wake-up is required, scales the Deployment
 * back to 1 replica, and waits for `readyReplicas >= 1`. No-ops for
 * non-k8s-sse runtimes, non-cold-start servers, or servers already ready.
 */
export function makeColdStartWakeup(
  opts: WakeColdStartedOptions,
): (serverId: string) => Promise<void> {
  return (serverId: string) => wakeServerIfIdle(serverId, opts);
}

/**
 * Imperative form of {@link makeColdStartWakeup}. Exported separately so
 * `K8sSseProvisioner.wakeIfIdle` can delegate without re-implementing the
 * scale-up + readiness-poll loop. Keep this and `makeColdStartWakeup` in
 * lock-step.
 */
export async function wakeServerIfIdle(
  serverId: string,
  opts: WakeColdStartedOptions,
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const row = (await prisma.mCPServer.findFirst({
    where: { id: serverId, deletedAt: null },
  })) as unknown as ReapableRow | null;
  if (!row) return;
  if (row.runtime !== "k8s-sse" || !row.coldStart) return;
  if (row.status === "ready") return;
  const cfg = getConfigService();
  const namespace = opts.namespace ?? cfg.get("MCP_K8S_NAMESPACE")?.trim() ?? "metis-mcp";
  const timeoutMs = opts.timeoutMs ?? cfg.getNumber("MCP_K8S_PROVISION_TIMEOUT_MS", 120_000);
  const name = buildResourceName(serverId);
  await scaleDeployment(opts.apis, namespace, name, 1);
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    try {
      const d = (await opts.apis.apps.readNamespacedDeployment({ name, namespace })) as
        | { status?: { readyReplicas?: number } }
        | { body: { status?: { readyReplicas?: number } } };
      const dep = "status" in d ? d : (d as { body: { status?: { readyReplicas?: number } } }).body;
      if ((dep.status?.readyReplicas ?? 0) >= 1) {
        await prisma.mCPServer.update({
          where: { id: serverId },
          data: { status: "ready" },
        });
        return;
      }
    } catch {
      // 404 or transient — keep polling until deadline.
    }
    await sleep(2_000);
  }
  throw new Error(
    `COLD_START_WAKE_TIMEOUT: ${serverId} did not become Ready within ${timeoutMs}ms`,
  );
}
