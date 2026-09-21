/**
 * Health-check endpoints.
 *
 * - `/api/health` and `/healthz` return 200 immediately (liveness).
 * - `/api/health/deep` and `/readyz` exercise the database and confirm the
 *   vault key is loaded (readiness).
 *
 * Neither route is authenticated.
 */
import { Router, type RequestHandler } from "express";
import type { DeepHealthCheck, HealthCheck } from "@metis/shared";
import { prisma } from "../lib/prisma.js";
import { createChildLogger } from "../lib/logger.js";
import { buildProvider, loadAIConfig } from "../lib/ai/index.js";
import type { AIProvider } from "../lib/ai/index.js";
import { getConfigService } from "../lib/config/index.js";
import { probeMCPRuntime } from "../health/mcp-runtime-probe.js";

const log = createChildLogger("health");

const startedAt = Date.now();
const VERSION = process.env.npm_package_version ?? "0.1.0";

let healthProviderOverride: AIProvider | null = null;
function getHealthProvider(): AIProvider {
  if (healthProviderOverride) return healthProviderOverride;
  return buildProvider({ config: loadAIConfig() });
}

/** Test seam — inject a stub provider for `/readyz` checks. */
export function setHealthProviderForTests(p: AIProvider | null): void {
  healthProviderOverride = p;
}

/**
 * Issue #263 — read `MCP_HEALTH_ALLOW_PARTIAL` fresh from `ConfigService`
 * on every health check so an admin flip in the UI takes effect immediately
 * without restarting the server. Falls back to env when the registry is
 * unreachable (e.g. tests that bypass `getConfigService`).
 */
export function readAllowPartial(): boolean {
  try {
    return getConfigService().getBool("MCP_HEALTH_ALLOW_PARTIAL", false);
  } catch {
    return process.env.MCP_HEALTH_ALLOW_PARTIAL === "1";
  }
}

export const liveHandler: RequestHandler = (_req, res) => {
  const payload: HealthCheck = {
    status: "ok",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: VERSION,
    timestamp: new Date().toISOString(),
  };
  res.json(payload);
};

export const deepHandler: RequestHandler = async (_req, res) => {
  const checks: DeepHealthCheck["checks"] = {};

  const dbStart = Date.now();
  try {
    await prisma.$queryRawUnsafe("SELECT 1");
    checks.database = { status: "ok", latencyMs: Date.now() - dbStart };
  } catch (err) {
    log.error("Database health check failed", { error: (err as Error).message });
    checks.database = { status: "error", message: (err as Error).message };
  }

  const hasVaultKey =
    Boolean(process.env.VAULT_MASTER_KEY) || process.env.NODE_ENV !== "production";
  checks.vault = hasVaultKey
    ? { status: "ok" }
    : { status: "error", message: "VAULT_MASTER_KEY missing" };

  // MCP subsystem (Phase 6) — deep check sums per-server statuses. Default is
  // "no failures may exist"; flipping the `MCP_HEALTH_ALLOW_PARTIAL` tunable
  // permits some servers to be unhealthy as long as at least one is ready.
  // Issue #263 — read fresh from `ConfigService` on every health check so an
  // admin flip in the UI takes effect on the next request, no restart.
  try {
    const { getMCPRegistry } = await import("../lib/mcp/index.js");
    let registry;
    try {
      registry = getMCPRegistry();
    } catch {
      registry = null;
    }
    if (registry) {
      const items = await registry.list();
      const enabled = items.filter((s: { enabled: boolean }) => s.enabled);
      const errored = enabled.filter((s: { status: string }) => s.status === "error");
      const ready = enabled.filter((s: { status: string }) => s.status === "ready");
      const allowPartial = readAllowPartial();
      if (enabled.length === 0) {
        checks.mcp = { status: "ok", message: "no servers configured" };
      } else if (errored.length === 0) {
        checks.mcp = { status: "ok", message: `${ready.length}/${enabled.length} ready` };
      } else if (allowPartial && ready.length > 0) {
        checks.mcp = {
          status: "degraded",
          message: `${errored.length} errored, ${ready.length}/${enabled.length} ready`,
        };
      } else {
        checks.mcp = {
          status: "error",
          message: `${errored.length}/${enabled.length} MCP servers in error`,
        };
      }
    }
  } catch (err) {
    log.warn("MCP health check failed", { error: (err as Error).message });
    checks.mcp = { status: "degraded", message: (err as Error).message };
  }

  // Scheduler subsystem (Phase 11) — deep check confirms the scheduler is
  // running and the task queue is responsive (last tick within the freshness
  // window).
  try {
    const { getSchedulerBootstrap } = await import("../lib/scheduler/index.js");
    let h: {
      status: "ok" | "degraded" | "error";
      message?: string;
      queueDepth: number;
      running: number;
      lastTickAt: number | null;
      enabled: boolean;
    } | null = null;
    try {
      const sched = getSchedulerBootstrap();
      h = sched.scheduler.health();
    } catch {
      h = null;
    }
    if (h == null) {
      checks.scheduler = { status: "ok", message: "not initialised" };
    } else if (!h.enabled) {
      checks.scheduler = { status: "ok", message: "disabled" };
    } else {
      const stale =
        h.lastTickAt != null && Date.now() - h.lastTickAt > 5 * 60 * 1000 && h.running > 0;
      checks.scheduler = stale
        ? {
            status: "degraded",
            message: `last tick ${Math.round((Date.now() - (h.lastTickAt ?? 0)) / 1000)}s ago`,
          }
        : { status: h.status, message: `queue=${h.queueDepth} running=${h.running}` };
    }
  } catch (err) {
    checks.scheduler = { status: "degraded", message: (err as Error).message };
  }

  // AI provider reachability — skipped in offline mode so /readyz stays cheap.
  const aiStart = Date.now();
  try {
    const cfg = loadAIConfig();
    if (cfg.offline) {
      checks.ai = { status: "ok", message: "offline-stub" };
    } else {
      const provider = getHealthProvider();
      const reachable = await Promise.race<boolean>([
        provider.ping(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), cfg.pingTimeoutMs)),
      ]);
      checks.ai = reachable
        ? { status: "ok", latencyMs: Date.now() - aiStart, message: cfg.provider }
        : { status: "degraded", message: `${cfg.provider} unreachable` };
    }
  } catch (err) {
    log.warn("AI health check failed", { error: (err as Error).message });
    checks.ai = { status: "degraded", message: (err as Error).message };
  }

  // Embeddings backend (issue #783). READINESS, not decoration: an embedder that
  // cannot load its model writes nothing, and — before #783 — one that had fallen
  // back to the hash stub wrote NON-SEMANTIC vectors while every probe stayed
  // green. Both states surface here now, and a hard load failure makes /readyz
  // return 503, so a rollout that broke the embeddings config never goes ready.
  //
  // Reads the SNAPSHOT, not an active probe: a readiness check must not trigger a
  // model download, and must not be able to hang on a wedged sidecar's socket
  // timeout (EMBEDDINGS_TIMEOUT_MS is 60s). `server.ts` warms the embedder at boot,
  // so by the time this matters the snapshot is a real answer, not a shrug.
  try {
    const { getEmbedder } = await import("../lib/rag/embedder.js");
    const health = getEmbedder().snapshot();
    if (health.status === "error") {
      checks.embeddings = {
        status: "error",
        message: `${health.backend}: ${health.error ?? "unavailable"}`,
      };
    } else if (health.fellBack) {
      checks.embeddings = {
        status: "degraded",
        message:
          `hash fallback ACTIVE (${health.model}, ${health.dimension}d) — vectors are NOT ` +
          `semantic. Anything ingested while this is true retrieves as noise.`,
      };
    } else {
      checks.embeddings = {
        status: "ok",
        message: health.loaded
          ? `${health.backend} ${health.model} (${health.dimension}d)`
          : `${health.backend} ${health.model} (${health.dimension}d) — not warmed yet`,
      };
    }
  } catch (err) {
    checks.embeddings = { status: "error", message: (err as Error).message };
  }

  // Issue #330 — MCP runtime substrate probe (network, wrapper image cache,
  // kubeconfig). Adds an `mcpRuntime` check whose `message` summarises the
  // sub-checks; full structured output is attached to the payload below.
  let mcpRuntimeDetail: unknown = null;
  try {
    const probe = await probeMCPRuntime();
    const summary = probe.checks.map((c) => `${c.name}=${c.status}`).join(" ");
    if (probe.status === "fail") {
      checks.mcpRuntime = { status: "degraded", message: summary };
    } else {
      checks.mcpRuntime = { status: "ok", message: summary };
    }
    mcpRuntimeDetail = probe;
  } catch (err) {
    checks.mcpRuntime = { status: "degraded", message: (err as Error).message };
  }

  const overall: DeepHealthCheck["status"] = Object.values(checks).every((c) => c.status === "ok")
    ? "ok"
    : Object.values(checks).some((c) => c.status === "error")
      ? "error"
      : "degraded";

  const body: DeepHealthCheck = {
    status: overall,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: VERSION,
    timestamp: new Date().toISOString(),
    checks,
  };
  if (mcpRuntimeDetail) {
    (body as unknown as { mcpRuntime?: unknown }).mcpRuntime = mcpRuntimeDetail;
  }
  res.status(overall === "error" ? 503 : 200).json(body);
};
export function healthRouter(): Router {
  const r = Router();
  r.get("/", liveHandler);
  r.get("/deep", deepHandler);
  return r;
}
