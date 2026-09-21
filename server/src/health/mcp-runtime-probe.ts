/**
 * Issue #330 — `/readyz` MCP runtime substrate probe.
 *
 * Surfaces in `/readyz` whether the substrate the MCP wrappers depend on is
 * actually reachable and provisioned. Today these gaps surface as cryptic
 * errors at first MCP registration; this probe makes them visible up front.
 *
 * Sub-checks:
 *   - `network`     → `metis-mcp` docker network present (only when
 *                     `MCP_RUNTIME=docker-stdio` or default).
 *   - `images`      → at least the 4 base wrapper images cached locally
 *                     (uvx-runner, jbang-runner, node-runner, npx-runner).
 *   - `dockerSocket`→ `docker info` succeeds (proves daemon reachable).
 *   - `kubeconfig`  → `KubeConfig.loadFromCluster()` /
 *                     `loadFromDefault()` produces a current context (only
 *                     when `MCP_RUNTIME=k8s-sse`).
 *
 * Each sub-check returns `{ name, status: 'ok' | 'fail' | 'skip', detail? }`.
 * Overall `status` is `'ok'` only when there are no `'fail'` entries.
 *
 * Probe results are cached for 30s to avoid hammering the docker daemon /
 * shelling out per `/readyz` hit.
 *
 * Reuses `scripts/bootstrap-check.sh`'s mental model — the two should agree.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export type ProbeStatus = "ok" | "fail" | "skip";

export interface SubCheck {
  name: string;
  status: ProbeStatus;
  detail?: string;
}

export interface MCPRuntimeProbeResult {
  status: "ok" | "fail";
  /** Lowercase substrate name, e.g. `"docker-stdio"`. */
  runtime: string;
  checks: SubCheck[];
  /** ms since epoch — when the cached snapshot was generated. */
  generatedAt: number;
}

const DEFAULT_NETWORK = "metis-mcp";
const DEFAULT_REGISTRY = "ghcr.io/metis-mcps";
/** Base wrappers callers must have cached. The bootstrap script checks the
 * versioned variant from `images/mcp-wrappers/VERSION`; this probe is more
 * lenient — any tag is acceptable, since the goal is to flag a totally cold
 * cache, not pin a version. */
const BASE_WRAPPERS = ["uvx-runner", "jbang-runner", "node-runner", "npx-runner"] as const;

const CACHE_TTL_MS = 30_000;

export interface MCPRuntimeProbeOptions {
  /** Test seam — overrides `process.env.MCP_RUNTIME`. */
  runtime?: string;
  /** Test seam — overrides `process.env.MCP_DOCKER_NETWORK`. */
  network?: string;
  /** Test seam — overrides `REGISTRY` env (default `ghcr.io/metis-mcps`). */
  registry?: string;
  /** Test seam — replace the docker invoker. Receives args; resolves with stdout, rejects with `{code, stderr}`-shape error. */
  dockerExec?: (args: string[], timeoutMs: number) => Promise<string>;
  /** Test seam — synchronous probe of kubeconfig reachability. */
  kubeconfigCheck?: () => { ok: boolean; detail?: string };
  /** Test seam — `Date.now()` injection for cache TTL math. */
  now?: () => number;
}

interface CacheEntry {
  expiresAt: number;
  value: MCPRuntimeProbeResult;
}

let cache: CacheEntry | null = null;

/** Drop the in-memory probe cache (for tests + post-config-flip refreshes). */
export function __resetMcpRuntimeProbeCache(): void {
  cache = null;
}

async function defaultDockerExec(args: string[], timeoutMs: number): Promise<string> {
  const { stdout } = await execFileP("docker", args, { timeout: timeoutMs });
  return stdout;
}

function defaultKubeconfigCheck(): { ok: boolean; detail?: string } {
  // Lazy require to avoid pulling @kubernetes/client-node into hot paths
  // when the runtime is docker-stdio.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const k8s = require("@kubernetes/client-node") as typeof import("@kubernetes/client-node");
    const kc = new k8s.KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    const ctx = kc.getCurrentContext();
    if (!ctx) return { ok: false, detail: "no current context in kubeconfig" };
    return { ok: true, detail: `context=${ctx}` };
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
}

/**
 * Run the probe (cached for 30s). Subsequent calls within the TTL return the
 * cached snapshot.
 */
export async function probeMCPRuntime(
  opts: MCPRuntimeProbeOptions = {},
): Promise<MCPRuntimeProbeResult> {
  const now = opts.now?.() ?? Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  const value = await runProbe(opts, now);
  cache = { expiresAt: now + CACHE_TTL_MS, value };
  return value;
}

async function runProbe(opts: MCPRuntimeProbeOptions, now: number): Promise<MCPRuntimeProbeResult> {
  const runtime = (opts.runtime ?? process.env.MCP_RUNTIME ?? "docker-stdio").toLowerCase();
  const network = opts.network ?? process.env.MCP_DOCKER_NETWORK ?? DEFAULT_NETWORK;
  const registry = opts.registry ?? process.env.REGISTRY ?? DEFAULT_REGISTRY;
  const dockerExec = opts.dockerExec ?? defaultDockerExec;
  const kubeconfigCheck = opts.kubeconfigCheck ?? defaultKubeconfigCheck;

  const checks: SubCheck[] = [];

  // dockerSocket — required for docker-stdio; informational for k8s-sse.
  let dockerReachable = false;
  if (runtime === "docker-stdio") {
    try {
      await dockerExec(["info", "--format", "{{.ServerVersion}}"], 3_000);
      checks.push({ name: "dockerSocket", status: "ok" });
      dockerReachable = true;
    } catch (err) {
      checks.push({
        name: "dockerSocket",
        status: "fail",
        detail: `docker daemon unreachable: ${(err as Error).message}`,
      });
    }
  } else {
    checks.push({ name: "dockerSocket", status: "skip", detail: `runtime=${runtime}` });
  }

  // network — only meaningful when docker-stdio. Skip otherwise.
  if (runtime === "docker-stdio") {
    if (!dockerReachable) {
      checks.push({
        name: "network",
        status: "fail",
        detail: `cannot probe '${network}' — docker unreachable`,
      });
    } else {
      try {
        await dockerExec(["network", "inspect", network], 3_000);
        checks.push({ name: "network", status: "ok", detail: network });
      } catch {
        checks.push({
          name: "network",
          status: "fail",
          detail: `network '${network}' missing — run 'docker compose up' or 'docker network create ${network}'`,
        });
      }
    }
  } else {
    checks.push({ name: "network", status: "skip", detail: `runtime=${runtime}` });
  }

  // images — only meaningful when docker is reachable. Skip otherwise.
  if (runtime !== "docker-stdio" || !dockerReachable) {
    checks.push({
      name: "images",
      status: "skip",
      detail: runtime !== "docker-stdio" ? `runtime=${runtime}` : "docker unreachable",
    });
  } else {
    const cached: string[] = [];
    const missing: string[] = [];
    for (const w of BASE_WRAPPERS) {
      try {
        // `docker image ls --format '{{.Repository}}'` then grep is more
        // forgiving than `docker image inspect` which requires an exact tag.
        const out = await dockerExec(
          ["image", "ls", "--format", "{{.Repository}}", `${registry}/${w}`],
          3_000,
        );
        if (out.trim().length > 0) cached.push(w);
        else missing.push(w);
      } catch {
        missing.push(w);
      }
    }
    if (missing.length === 0) {
      checks.push({
        name: "images",
        status: "ok",
        detail: `${cached.length}/${BASE_WRAPPERS.length} cached`,
      });
    } else {
      checks.push({
        name: "images",
        status: "fail",
        detail: `${missing.length} wrapper images missing: ${missing.join(",")} — run 'pnpm bootstrap'`,
      });
    }
  }

  // kubeconfig — only when runtime=k8s-sse.
  if (runtime === "k8s-sse") {
    const r = kubeconfigCheck();
    checks.push({
      name: "kubeconfig",
      status: r.ok ? "ok" : "fail",
      detail: r.detail,
    });
  } else {
    checks.push({ name: "kubeconfig", status: "skip", detail: `runtime=${runtime}` });
  }

  const overall: "ok" | "fail" = checks.some((c) => c.status === "fail") ? "fail" : "ok";
  return { status: overall, runtime, checks, generatedAt: now };
}
