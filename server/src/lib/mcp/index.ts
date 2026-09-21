/**
 * Phase 6 — MCP Server Registry public surface.
 *
 * `bootstrapMCP` wires the lifecycle manager + service + health monitor and
 * registers them with the singletons used by routes. Returns a teardown
 * function for graceful shutdown + tests.
 */
import { createChildLogger } from "../logger.js";
import type { MetisIOServer } from "../socket/server.js";
import { expandVaultRefs } from "../vault/env-manager.js";
import { getVaultService } from "../vault/vault-service.js";
import { setApprovalNotifier } from "./approval.js";
import { MCPHealthMonitor } from "./health-monitor.js";
import { MCPIdleReaper } from "./idle-reaper.js";
import { K8sColdStartReaper } from "./k8s-cold-start-reaper.js";
import { MCPLifecycleManager } from "./lifecycle-manager.js";
import { MCPRegistryService, getMCPRegistry, setMCPRegistry } from "./mcp-service.js";
import { K8sSseProvisioner, defaultProvisionerRegistry } from "./provisioners/index.js";
import { MCPToolBridge } from "./tool-bridge.js";
import { PagerDutyProviderStatusWatcher } from "../pagerduty/provider-status-watcher.js";

const log = createChildLogger("mcp-bootstrap");

export interface BootstrapOptions {
  io?: MetisIOServer | null;
  startHealthMonitor?: boolean;
}

export interface MCPBootstrap {
  lifecycle: MCPLifecycleManager;
  registry: MCPRegistryService;
  health: MCPHealthMonitor;
  idleReaper: MCPIdleReaper;
  /** Epic #272 / sub-issue #290 — cold-start sweeper for k8s-sse pods. */
  coldStartReaper: K8sColdStartReaper;
  bridge: MCPToolBridge;
  shutdown: () => Promise<void>;
}

export function bootstrapMCP(opts: BootstrapOptions = {}): MCPBootstrap {
  // Build the provisioner registry once so the bootstrap can reach into the
  // k8s-sse provisioner for its API clients (cold-start reaper) AND for its
  // wake-up hook (tool bridge). Sharing the instance keeps the cached
  // KubeConfig + apis honest.
  const provisioners = defaultProvisionerRegistry();
  const k8sProvisioner = provisioners["k8s-sse"];
  const k8sSse = k8sProvisioner instanceof K8sSseProvisioner ? k8sProvisioner : null;

  const lifecycle = new MCPLifecycleManager({
    provisioners,
    resolveEnv: async (env) => expandVaultRefs(env, getVaultService()),
    emitStatus: (event) => {
      if (opts.io) {
        opts.io.to("mcp:status").emit("mcp:status", event);
      }
    },
  });
  const registry = new MCPRegistryService(lifecycle);
  setMCPRegistry(registry);
  const bridge = new MCPToolBridge(lifecycle, registry, {
    coldStartWakeup: k8sSse ? (id: string) => k8sSse.wakeIfIdle(id) : undefined,
  });
  const detachBridge = bridge.attach();
  // Issue #580 — PagerDuty sev-1 alerting on provider/sandbox down. The watcher
  // fires a paging incident on the edge into `error` and resolves it when the
  // server returns to `ready`. Best-effort/non-throwing; no-op unless the owning
  // (or ops) workspace has a PagerDuty service configured.
  const pagerDutyWatcher = new PagerDutyProviderStatusWatcher();
  const detachPagerDuty = lifecycle.onStatus((event) => {
    void pagerDutyWatcher.onStatus(event);
  });

  const health = new MCPHealthMonitor(lifecycle);
  if (opts.startHealthMonitor !== false) health.start();
  // Issue #277 — idle reaper sweeps user-scoped MCPs every 5 minutes.
  const idleReaper = new MCPIdleReaper(lifecycle);
  if (opts.startHealthMonitor !== false) idleReaper.start();
  // Sub-issue #290 — cold-start sweeper. Lazy `apisProvider` so the reaper
  // boots cleanly on hosts without a kubeconfig (sweeps no-op until the
  // first k8s-sse provision warms the cache).
  const coldStartReaper = new K8sColdStartReaper(lifecycle, {
    apisProvider: k8sSse ? () => k8sSse.tryGetApis() : undefined,
  });
  if (opts.startHealthMonitor !== false) coldStartReaper.start();

  // Epic #162 — wire the per-session approval notifier into Socket.IO so the
  // chat-side prompt component can react to `mcp:approval:requested` and
  // post a decision back via `/api/mcp/approvals/:id/decide`.
  if (opts.io) {
    const io = opts.io;
    setApprovalNotifier({
      emit(event) {
        io.to(`session:${event.sessionId}`).emit("mcp:approval:requested", event);
      },
      emitDecision(event) {
        io.to(`session:${event.sessionId}`).emit("mcp:approval:decided", event);
      },
    });
  }

  return {
    lifecycle,
    registry,
    health,
    idleReaper,
    coldStartReaper,
    bridge,
    async shutdown() {
      health.stop();
      idleReaper.stop();
      coldStartReaper.stop();
      detachBridge();
      detachPagerDuty();
      bridge.shutdown();
      await lifecycle.stopAll();
      setApprovalNotifier(null);
      setMCPRegistry(null);
      log.info("MCP subsystem shut down");
    },
  };
}

export {
  MCPHealthMonitor,
  MCPLifecycleManager,
  MCPRegistryService,
  MCPToolBridge,
  getMCPRegistry,
  setMCPRegistry,
};
export type { MCPServerView } from "./mcp-service.js";
