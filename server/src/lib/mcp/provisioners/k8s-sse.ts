/**
 * Epic #272 / Sub-issue #285 — Kubernetes SSE provisioner.
 *
 * For runtime `k8s-sse`:
 *   1. Validate the wrapper image against `MCP_IMAGE_ALLOWLIST` (defence-in-
 *      depth — the registry already enforced it on write).
 *   2. (Optional) Create a per-MCP ServiceAccount with IRSA annotation.
 *   3. Create a ClusterIP `Service` (port 8080) and a `Deployment` (1
 *      replica) with the wrapper image, env-vars, and a hardened
 *      securityContext (non-root, read-only rootfs, drop-all caps).
 *   4. Apply a `NetworkPolicy` that denies egress except DNS + the configured
 *      per-server / global allowlist entries.
 *   5. Wait for the Deployment to be Ready.
 *   6. Return a `ProvisionedEndpoint` whose `url` points at the service's
 *      in-cluster FQDN. The lifecycle manager wires up an SSE transport.
 *
 * Idempotency: existing resources owned by the provisioner (matched by
 * label `metis.io/server-id=<id>`) are reused — METIS pod restarts don't
 * duplicate Deployments.
 *
 * Cleanup tears down NetworkPolicy + Service + Deployment + (optional) SA.
 *
 * Cluster connection:
 *   - In-cluster (METIS pod itself) — `KubeConfig.loadFromCluster()` when
 *     `KUBERNETES_SERVICE_HOST` is set.
 *   - Local dev — `KubeConfig.loadFromDefault()` (kubeconfig).
 */
import {
  AppsV1Api,
  CoreV1Api,
  KubeConfig,
  Log,
  NetworkingV1Api,
  type V1Deployment,
  type V1Service,
} from "@kubernetes/client-node";
import { PassThrough } from "node:stream";
import { createChildLogger } from "../../logger.js";
import { getConfigService } from "../../config/config-service.js";
import { imageMatchesAllowlist, parseAllowlistCsv } from "../image-allowlist.js";
import type { MCPServerConfig } from "../types.js";
import { K8sLogStreamer, TokenBucket } from "./log-streamer.js";
import { buildNetworkPolicy } from "./network-policy.js";
import { buildSecret, buildSecretEnvRefs } from "./secret.js";
import { buildServiceAccount, composeRoleArn } from "./service-account.js";
import type { ContainerProvisioner, ProvisionedEndpoint } from "./types.js";
import { createHash } from "node:crypto";

const log = createChildLogger("mcp-k8s-provisioner");

const DEFAULT_NAMESPACE = "metis-mcp";
const DEFAULT_SERVICE_DOMAIN = "cluster.local";
const DEFAULT_PROVISION_TIMEOUT_MS = 120_000;
const DEFAULT_MEMORY_LIMIT = "512Mi";
const DEFAULT_MEMORY_REQUEST = "128Mi";
const DEFAULT_CPU_LIMIT = "1000m";
const DEFAULT_CPU_REQUEST = "100m";
const CONTAINER_PORT = 8080;

/**
 * Per-server resource name. Uses a SHA-256 of the server id so the result is
 * (a) deterministic, (b) ≤ 63 chars (k8s name rule), (c) safe for any input.
 */
export function buildResourceName(serverId: string): string {
  const hash = createHash("sha256").update(serverId).digest("hex").slice(0, 12);
  return `mcp-${hash}`;
}

/** Common label set used for selector + cleanup-by-label. */
function managedLabels(serverId: string): Record<string, string> {
  return {
    "metis.io/managed-by": "mcp-provisioner",
    "metis.io/server-id": serverId,
  };
}

export interface K8sApis {
  apps: Pick<
    AppsV1Api,
    | "createNamespacedDeployment"
    | "readNamespacedDeployment"
    | "deleteNamespacedDeployment"
    | "patchNamespacedDeployment"
  >;
  core: Pick<
    CoreV1Api,
    | "createNamespacedService"
    | "deleteNamespacedService"
    | "createNamespacedServiceAccount"
    | "deleteNamespacedServiceAccount"
    | "createNamespacedSecret"
    | "deleteNamespacedSecret"
    | "readNamespacedService"
    | "listNamespacedPod"
  >;
  networking: Pick<
    NetworkingV1Api,
    "createNamespacedNetworkPolicy" | "deleteNamespacedNetworkPolicy"
  >;
}

/**
 * Factory that returns a started log streamer for the given pod, or null if
 * streaming is unavailable. Injected so tests can avoid touching real k8s
 * pod-log endpoints.
 */
export interface LogStreamerHandle {
  stop(): void;
}
export type LogStreamerFactory = (input: {
  apis: K8sApis;
  namespace: string;
  resourceName: string;
  serverId: string;
}) => Promise<LogStreamerHandle | null> | LogStreamerHandle | null;

export interface K8sSseProvisionerOptions {
  /** Inject API clients for tests. When omitted, KubeConfig is loaded from in-cluster / kubeconfig. */
  apis?: K8sApis;
  /** Test seam — clock. */
  now?: () => number;
  /** Test seam — sleep. Default `setTimeout`-based. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam — alternate log streamer factory. Default uses k8s `Log` + PassThrough. */
  logStreamerFactory?: LogStreamerFactory;
}

const isAlreadyExists = (err: unknown): boolean => {
  // The k8s client throws an HttpError-shaped object whose `.code === 409`
  // (or `.body.code === 409`) when a resource already exists. We check both.
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; body?: { code?: number } };
  return e.code === 409 || e.body?.code === 409;
};

const isNotFound = (err: unknown): boolean => {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; body?: { code?: number } };
  return e.code === 404 || e.body?.code === 404;
};

export class K8sSseProvisioner implements ContainerProvisioner {
  private apisCache: K8sApis | null;
  private kubeConfigCache: KubeConfig | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly logStreamerFactory: LogStreamerFactory;

  constructor(opts: K8sSseProvisionerOptions = {}) {
    this.apisCache = opts.apis ?? null;
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
    this.logStreamerFactory = opts.logStreamerFactory ?? this.defaultLogStreamerFactory.bind(this);
  }

  /** Resolve the K8s API clients lazily so tests don't need a real kubeconfig. */
  private apis(): K8sApis {
    if (this.apisCache) return this.apisCache;
    const kc = new KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    this.kubeConfigCache = kc;
    this.apisCache = {
      apps: kc.makeApiClient(AppsV1Api),
      core: kc.makeApiClient(CoreV1Api),
      networking: kc.makeApiClient(NetworkingV1Api),
    };
    return this.apisCache;
  }

  /**
   * Best-effort accessor for the K8s API clients. Returns null if no cached
   * apis are available AND constructing them from kubeconfig fails (typical
   * for local dev without ~/.kube/config). Used by the cold-start reaper —
   * never throws so a missing kubeconfig can't crash bootstrap.
   */
  tryGetApis(): K8sApis | null {
    if (this.apisCache) return this.apisCache;
    try {
      return this.apis();
    } catch {
      return null;
    }
  }

  /**
   * Sub-issue #290 wake hook. Called via `MCPToolBridge.coldStartWakeup`
   * before each tool invocation. Patches the per-MCP Deployment back to
   * `replicas: 1` and waits for `readyReplicas >= 1`. No-op for runtimes
   * other than `k8s-sse`, for non-cold-start servers, or for servers
   * already in the `ready` state. The method is exported on the provisioner
   * (rather than a free factory) so the bridge doesn't have to know about
   * KubeConfig wiring — give the provisioner the responsibility, hand it
   * back to the bridge as a closure.
   */
  async wakeIfIdle(serverId: string): Promise<void> {
    const apis = this.tryGetApis();
    if (!apis) return;
    const cfg = getConfigService();
    const namespace = sanitiseString(cfg.get("MCP_K8S_NAMESPACE"), DEFAULT_NAMESPACE);
    const timeoutMs = sanitiseInt(
      cfg.get("MCP_K8S_PROVISION_TIMEOUT_MS"),
      DEFAULT_PROVISION_TIMEOUT_MS,
    );
    // Lazy-load to avoid an import cycle with k8s-cold-start-reaper.
    const { wakeServerIfIdle } = await import("../k8s-cold-start-reaper.js");
    await wakeServerIfIdle(serverId, {
      apis,
      namespace,
      timeoutMs,
      now: this.now,
      sleep: this.sleep,
    });
  }

  async provision(
    config: MCPServerConfig,
    resolvedEnv: Record<string, string>,
  ): Promise<ProvisionedEndpoint> {
    if (!config.command) {
      throw new Error(
        "k8s-sse runtime requires `command` (interpreted as wrapper image reference)",
      );
    }
    const image = config.command;

    // Defence-in-depth — re-check allowlist at provision time.
    const cfg = getConfigService();
    const patterns = parseAllowlistCsv(cfg.get("MCP_IMAGE_ALLOWLIST") ?? null);
    if (!imageMatchesAllowlist(image, patterns)) {
      throw new Error(
        `IMAGE_NOT_ALLOWED: '${image}' does not match any allowlisted pattern (${patterns.length} configured)`,
      );
    }

    const namespace = sanitiseString(cfg.get("MCP_K8S_NAMESPACE"), DEFAULT_NAMESPACE);
    const serviceDomain = sanitiseString(cfg.get("MCP_K8S_SERVICE_DOMAIN"), DEFAULT_SERVICE_DOMAIN);
    const provisionTimeoutMs = sanitiseInt(
      cfg.get("MCP_K8S_PROVISION_TIMEOUT_MS"),
      DEFAULT_PROVISION_TIMEOUT_MS,
    );
    const memoryLimit = sanitiseString(
      (config as { k8sMemoryLimit?: string | null }).k8sMemoryLimit ??
        cfg.get("MCP_K8S_MEMORY_LIMIT"),
      DEFAULT_MEMORY_LIMIT,
    );
    const memoryRequest = sanitiseString(cfg.get("MCP_K8S_MEMORY_REQUEST"), DEFAULT_MEMORY_REQUEST);
    const cpuLimit = sanitiseString(
      (config as { k8sCpuLimit?: string | null }).k8sCpuLimit ?? cfg.get("MCP_K8S_CPU_LIMIT"),
      DEFAULT_CPU_LIMIT,
    );
    const cpuRequest = sanitiseString(cfg.get("MCP_K8S_CPU_REQUEST"), DEFAULT_CPU_REQUEST);
    const irsaPrefix = (cfg.get("MCP_K8S_IRSA_ROLE_ARN_PREFIX") ?? "").trim();

    const resourceName = buildResourceName(config.id);
    const labels = managedLabels(config.id);
    const apis = this.apis();

    // 1. ServiceAccount (optional — only when IRSA is configured).
    let serviceAccountName = "default";
    let mountSaToken = false;
    if (irsaPrefix) {
      const roleArn = composeRoleArn(irsaPrefix, config.id);
      const sa = buildServiceAccount({
        serverId: config.id,
        resourceName,
        namespace,
        roleArn,
      });
      try {
        await apis.core.createNamespacedServiceAccount({ namespace, body: sa });
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
      serviceAccountName = resourceName;
      mountSaToken = true;
    }

    // 2. NetworkPolicy.
    const allowlistRaw =
      (config as { egressAllowlist?: string | null }).egressAllowlist ??
      cfg.get("MCP_K8S_EGRESS_ALLOWLIST") ??
      "";
    const np = buildNetworkPolicy({
      serverId: config.id,
      resourceName,
      namespace,
      allowlist: allowlistRaw
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0),
    });
    try {
      await apis.networking.createNamespacedNetworkPolicy({ namespace, body: np });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }

    // 3. Service (ClusterIP).
    const svc: V1Service = {
      apiVersion: "v1",
      kind: "Service",
      metadata: { name: resourceName, namespace, labels },
      spec: {
        type: "ClusterIP",
        selector: labels,
        ports: [{ port: CONTAINER_PORT, targetPort: CONTAINER_PORT, protocol: "TCP", name: "sse" }],
      },
    };
    try {
      await apis.core.createNamespacedService({ namespace, body: svc });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }

    // 4. Deployment.
    //
    // Issue #317 (OWASP A07): never inline env values in the Deployment
    // spec — they would be visible to anyone with `kubectl get deploy -o
    // yaml`. Instead, push them into a per-MCP `Secret` (created BEFORE the
    // Deployment so the controller never sees a missing-secret event) and
    // reference each value via `valueFrom.secretKeyRef`.
    const secret = buildSecret({
      serverId: config.id,
      resourceName,
      namespace,
      env: resolvedEnv,
    });
    if (secret) {
      try {
        await apis.core.createNamespacedSecret({ namespace, body: secret });
      } catch (err) {
        if (!isAlreadyExists(err)) throw err;
      }
    }
    const envVars = buildSecretEnvRefs(resourceName, resolvedEnv);
    const deployment: V1Deployment = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: resourceName, namespace, labels },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            serviceAccountName,
            automountServiceAccountToken: mountSaToken,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              fsGroup: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "mcp",
                image,
                args: config.args ?? [],
                ports: [{ containerPort: CONTAINER_PORT, name: "sse", protocol: "TCP" }],
                env: envVars,
                resources: {
                  limits: { memory: memoryLimit, cpu: cpuLimit },
                  requests: { memory: memoryRequest, cpu: cpuRequest },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    };
    try {
      await apis.apps.createNamespacedDeployment({ namespace, body: deployment });
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }

    // 5. Wait for Ready.
    try {
      await this.waitForReady(apis, namespace, resourceName, provisionTimeoutMs);
    } catch (err) {
      // Best-effort cleanup before propagating the failure.
      await this.tearDown(apis, namespace, resourceName, irsaPrefix !== "", secret !== null);
      throw err;
    }

    // 6. Sub-issue #292 — start log mirroring. Best-effort: if the streamer
    // factory fails the pod still runs, we just won't tail its logs.
    let logStreamer: LogStreamerHandle | null = null;
    try {
      logStreamer = await this.logStreamerFactory({
        apis,
        namespace,
        resourceName,
        serverId: config.id,
      });
    } catch (err) {
      log.warn("k8s-sse log streamer failed to start", {
        serverId: config.id,
        resourceName,
        error: (err as Error).message,
      });
    }

    const url = `http://${resourceName}.${namespace}.svc.${serviceDomain}:${CONTAINER_PORT}/sse`;
    log.debug("Provisioned k8s-sse MCP", {
      serverId: config.id,
      resourceName,
      namespace,
      url,
      memoryLimit,
      cpuLimit,
      irsa: irsaPrefix !== "",
      logStreaming: logStreamer !== null,
    });

    return {
      transport: "sse",
      url,
      cleanup: async () => {
        try {
          logStreamer?.stop();
        } catch (err) {
          log.warn("k8s-sse log streamer stop hook threw", {
            serverId: config.id,
            error: (err as Error).message,
          });
        }
        try {
          await this.tearDown(apis, namespace, resourceName, irsaPrefix !== "", secret !== null);
        } catch (err) {
          log.warn("k8s-sse cleanup hook failed", {
            serverId: config.id,
            resourceName,
            error: (err as Error).message,
          });
        }
      },
    };
  }

  /**
   * Poll the Deployment until `status.readyReplicas >= 1` or timeout.
   * Linear polling at 2s intervals — k8s watch is overkill for one resource.
   */
  private async waitForReady(
    apis: K8sApis,
    namespace: string,
    name: string,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      try {
        const d = (await apis.apps.readNamespacedDeployment({ name, namespace })) as
          | V1Deployment
          | { body: V1Deployment };
        const dep = "spec" in d ? d : (d as { body: V1Deployment }).body;
        const ready = dep.status?.readyReplicas ?? 0;
        if (ready >= 1) return;
      } catch (err) {
        if (!isNotFound(err)) throw err;
      }
      await this.sleep(2_000);
    }
    throw new Error(
      `K8S_PROVISION_TIMEOUT: Deployment ${namespace}/${name} did not become Ready within ${timeoutMs}ms`,
    );
  }

  /** Best-effort delete of all managed resources. Swallows 404s. */
  private async tearDown(
    apis: K8sApis,
    namespace: string,
    name: string,
    deleteServiceAccount: boolean,
    deleteSecret: boolean,
  ): Promise<void> {
    const ops: Array<Promise<unknown>> = [
      apis.apps.deleteNamespacedDeployment({ name, namespace }).catch((e) => {
        if (!isNotFound(e)) throw e;
      }),
      apis.core.deleteNamespacedService({ name, namespace }).catch((e) => {
        if (!isNotFound(e)) throw e;
      }),
      apis.networking.deleteNamespacedNetworkPolicy({ name, namespace }).catch((e) => {
        if (!isNotFound(e)) throw e;
      }),
    ];
    if (deleteServiceAccount) {
      ops.push(
        apis.core.deleteNamespacedServiceAccount({ name, namespace }).catch((e) => {
          if (!isNotFound(e)) throw e;
        }),
      );
    }
    // Issue #317 — Secret teardown stays atomic with the rest.
    if (deleteSecret) {
      ops.push(
        apis.core.deleteNamespacedSecret({ name, namespace }).catch((e) => {
          if (!isNotFound(e)) throw e;
        }),
      );
    }
    await Promise.all(ops);
  }

  /**
   * Default log streamer — finds the first running pod for the Deployment,
   * follows its logs via `Log` + `PassThrough`, and pipes the stream
   * through a `K8sLogStreamer` rate-limiter into the per-MCP child logger.
   * Returns null when no pods are found OR no `KubeConfig` is available.
   * Failures are propagated to the caller (logged + swallowed there) so
   * production wiring stays best-effort.
   */
  private async defaultLogStreamerFactory(input: {
    apis: K8sApis;
    namespace: string;
    resourceName: string;
    serverId: string;
  }): Promise<LogStreamerHandle | null> {
    const cfg = getConfigService();
    const raw = (await input.apis.core.listNamespacedPod({
      namespace: input.namespace,
      labelSelector: `metis.io/server-id=${input.serverId}`,
    } as unknown as Parameters<K8sApis["core"]["listNamespacedPod"]>[0])) as unknown;
    type PodList = { items?: Array<{ metadata?: { name?: string } }> };
    const list: PodList =
      raw && typeof raw === "object" && "body" in raw
        ? ((raw as { body: PodList }).body ?? {})
        : (raw as PodList);
    const podName = list.items?.[0]?.metadata?.name;
    if (!podName) return null;
    if (!this.kubeConfigCache) return null;

    const ratePerSec = sanitiseInt(cfg.get("MCP_K8S_LOG_LINES_PER_SEC"), 50);
    const burst = sanitiseInt(cfg.get("MCP_K8S_LOG_BURST"), 200);
    const bucket = new TokenBucket({ ratePerSec, burst });
    const logger = createChildLogger(`mcp-pod:${input.serverId}`);
    const streamer = new K8sLogStreamer({ serverId: input.serverId, bucket, logger });

    const ps = new PassThrough();
    const logApi = new Log(this.kubeConfigCache);
    const abort = await logApi.log(input.namespace, podName, "mcp", ps, { follow: true });
    streamer.attach(ps as unknown as AsyncIterable<Uint8Array | string>);
    return {
      stop() {
        try {
          abort.abort();
        } catch {
          // best-effort
        }
        try {
          ps.destroy();
        } catch {
          // best-effort
        }
        streamer.stop();
      },
    };
  }
}

function sanitiseString(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function sanitiseInt(raw: string | null | undefined, fallback: number): number {
  if (typeof raw !== "string") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
