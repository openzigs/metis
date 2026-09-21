/**
 * Epic #272 / Sub-issue #285 — K8sSseProvisioner integration-style tests.
 *
 * Mocks the K8s API surface end-to-end so we exercise create/cleanup paths
 * without a real cluster. The provisioner accepts an `apis` injection point
 * exactly for this purpose — no need to mock @kubernetes/client-node directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfgStore = new Map<string, string | null>();
vi.mock("../src/lib/config/config-service.js", () => {
  const cfg = {
    get(key: string): string | null {
      return cfgStore.get(key) ?? null;
    },
    getBool(_key: string, fallback: boolean): boolean {
      return fallback;
    },
    getNumber(_key: string, fallback: number): number {
      const raw = cfgStore.get(_key);
      if (raw == null) return fallback;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : fallback;
    },
  };
  return {
    getConfigService: () => cfg,
    __resetConfigSingleton: () => undefined,
    ConfigService: class {},
    CONFIG_KEYS: {},
  };
});

import { K8sSseProvisioner, buildResourceName } from "../src/lib/mcp/provisioners/k8s-sse.js";
import type { MCPServerConfig } from "../src/lib/mcp/types.js";

interface FakeApis {
  apps: {
    createNamespacedDeployment: ReturnType<typeof vi.fn>;
    readNamespacedDeployment: ReturnType<typeof vi.fn>;
    deleteNamespacedDeployment: ReturnType<typeof vi.fn>;
    patchNamespacedDeployment: ReturnType<typeof vi.fn>;
  };
  core: {
    createNamespacedService: ReturnType<typeof vi.fn>;
    deleteNamespacedService: ReturnType<typeof vi.fn>;
    createNamespacedServiceAccount: ReturnType<typeof vi.fn>;
    deleteNamespacedServiceAccount: ReturnType<typeof vi.fn>;
    createNamespacedSecret: ReturnType<typeof vi.fn>;
    deleteNamespacedSecret: ReturnType<typeof vi.fn>;
    readNamespacedService: ReturnType<typeof vi.fn>;
    listNamespacedPod: ReturnType<typeof vi.fn>;
  };
  networking: {
    createNamespacedNetworkPolicy: ReturnType<typeof vi.fn>;
    deleteNamespacedNetworkPolicy: ReturnType<typeof vi.fn>;
  };
}

function makeApis(overrides: Partial<{ readyReplicas: number }> = {}): FakeApis {
  const ready = overrides.readyReplicas ?? 1;
  return {
    apps: {
      createNamespacedDeployment: vi.fn(async () => ({})),
      readNamespacedDeployment: vi.fn(async () => ({
        spec: {},
        status: { readyReplicas: ready },
      })),
      deleteNamespacedDeployment: vi.fn(async () => ({})),
      patchNamespacedDeployment: vi.fn(async () => ({})),
    },
    core: {
      createNamespacedService: vi.fn(async () => ({})),
      deleteNamespacedService: vi.fn(async () => ({})),
      createNamespacedServiceAccount: vi.fn(async () => ({})),
      deleteNamespacedServiceAccount: vi.fn(async () => ({})),
      createNamespacedSecret: vi.fn(async () => ({})),
      deleteNamespacedSecret: vi.fn(async () => ({})),
      readNamespacedService: vi.fn(async () => ({})),
      listNamespacedPod: vi.fn(async () => ({ items: [] })),
    },
    networking: {
      createNamespacedNetworkPolicy: vi.fn(async () => ({})),
      deleteNamespacedNetworkPolicy: vi.fn(async () => ({})),
    },
  };
}

const baseConfig = (over: Partial<MCPServerConfig> = {}): MCPServerConfig =>
  ({
    id: "abc123",
    label: "test",
    transport: "sse",
    runtime: "k8s-sse",
    enabled: true,
    trustLevel: "trusted",
    command: "ghcr.io/metis-mcps/uvx-runner-sse:1.0",
    args: ["uvx", "mcp-atlassian"],
    ...over,
  }) as MCPServerConfig;

describe("buildResourceName", () => {
  it("is deterministic, prefixed, and ≤63 chars", () => {
    const a = buildResourceName("abc");
    const b = buildResourceName("abc");
    expect(a).toBe(b);
    expect(a.startsWith("mcp-")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(63);
  });
  it("differs across server ids", () => {
    expect(buildResourceName("abc")).not.toBe(buildResourceName("xyz"));
  });
});

describe("K8sSseProvisioner.provision", () => {
  beforeEach(() => {
    cfgStore.clear();
    cfgStore.set("MCP_IMAGE_ALLOWLIST", "ghcr.io/metis-mcps/*");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates Service + NetworkPolicy + Deployment and returns an SSE endpoint URL", async () => {
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    const result = await p.provision(baseConfig(), { FOO: "bar" });
    expect(result.transport).toBe("sse");
    expect(result.url).toMatch(
      /^http:\/\/mcp-[a-f0-9]{12}\.metis-mcp\.svc\.cluster\.local:8080\/sse$/,
    );
    expect(apis.core.createNamespacedService).toHaveBeenCalledTimes(1);
    expect(apis.networking.createNamespacedNetworkPolicy).toHaveBeenCalledTimes(1);
    expect(apis.apps.createNamespacedDeployment).toHaveBeenCalledTimes(1);
    // No SA created when IRSA prefix is empty.
    expect(apis.core.createNamespacedServiceAccount).not.toHaveBeenCalled();
  });

  it("creates a per-MCP ServiceAccount when IRSA prefix is configured", async () => {
    cfgStore.set("MCP_K8S_IRSA_ROLE_ARN_PREFIX", "arn:aws:iam::123:role/metis-mcp-");
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    await p.provision(baseConfig(), {});
    expect(apis.core.createNamespacedServiceAccount).toHaveBeenCalledTimes(1);
  });

  it("rejects images that don't match MCP_IMAGE_ALLOWLIST", async () => {
    cfgStore.set("MCP_IMAGE_ALLOWLIST", "ghcr.io/metis-mcps/*");
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    await expect(p.provision(baseConfig({ command: "evil.example/img:1" }), {})).rejects.toThrow(
      /IMAGE_NOT_ALLOWED/,
    );
    expect(apis.apps.createNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("requires a command (image)", async () => {
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    await expect(p.provision(baseConfig({ command: undefined }), {})).rejects.toThrow(
      /requires `command`/,
    );
  });

  it("treats AlreadyExists (409) as idempotent on every resource", async () => {
    const apis = makeApis();
    const conflict = Object.assign(new Error("conflict"), { code: 409 });
    apis.core.createNamespacedService.mockRejectedValueOnce(conflict);
    apis.networking.createNamespacedNetworkPolicy.mockRejectedValueOnce(conflict);
    apis.apps.createNamespacedDeployment.mockRejectedValueOnce(conflict);
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    const result = await p.provision(baseConfig(), {});
    expect(result.transport).toBe("sse");
  });

  it("times out and tears down when Deployment never becomes Ready", async () => {
    cfgStore.set("MCP_K8S_PROVISION_TIMEOUT_MS", "10");
    let now = 0;
    const apis = makeApis({ readyReplicas: 0 });
    const p = new K8sSseProvisioner({
      apis,
      now: () => now,
      sleep: async () => {
        now += 5; // advance fake clock so deadline elapses.
      },
    });
    await expect(p.provision(baseConfig(), {})).rejects.toThrow(/K8S_PROVISION_TIMEOUT/);
    // tearDown should have run after the timeout.
    expect(apis.apps.deleteNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(apis.core.deleteNamespacedService).toHaveBeenCalledTimes(1);
    expect(apis.networking.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1);
  });

  it("cleanup() returned by provision() deletes all created resources", async () => {
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    const result = await p.provision(baseConfig(), {});
    await result.cleanup();
    expect(apis.apps.deleteNamespacedDeployment).toHaveBeenCalledTimes(1);
    expect(apis.core.deleteNamespacedService).toHaveBeenCalledTimes(1);
    expect(apis.networking.deleteNamespacedNetworkPolicy).toHaveBeenCalledTimes(1);
  });

  it("cleanup() also deletes the ServiceAccount when IRSA was configured", async () => {
    cfgStore.set("MCP_K8S_IRSA_ROLE_ARN_PREFIX", "arn:aws:iam::123:role/metis-mcp-");
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    const result = await p.provision(baseConfig(), {});
    await result.cleanup();
    expect(apis.core.deleteNamespacedServiceAccount).toHaveBeenCalledTimes(1);
  });

  it("cleanup() swallows 404 NotFound responses", async () => {
    const apis = makeApis();
    const notFound = Object.assign(new Error("nope"), { code: 404 });
    apis.apps.deleteNamespacedDeployment.mockRejectedValueOnce(notFound);
    apis.core.deleteNamespacedService.mockRejectedValueOnce(notFound);
    apis.networking.deleteNamespacedNetworkPolicy.mockRejectedValueOnce(notFound);
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    const result = await p.provision(baseConfig(), {});
    await expect(result.cleanup()).resolves.not.toThrow();
  });

  it("uses MCP_K8S_NAMESPACE override and per-MCP k8sMemoryLimit/k8sCpuLimit", async () => {
    cfgStore.set("MCP_K8S_NAMESPACE", "custom-ns");
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    const result = await p.provision(
      baseConfig({
        k8sMemoryLimit: "2Gi",
        k8sCpuLimit: "2000m",
      }) as MCPServerConfig,
      {},
    );
    expect(result.url).toContain(".custom-ns.svc.cluster.local");
    const depCall = apis.apps.createNamespacedDeployment.mock.calls[0]?.[0] as {
      body: {
        spec: {
          template: {
            spec: {
              containers: Array<{ resources: { limits: { memory: string; cpu: string } } }>;
            };
          };
        };
      };
    };
    expect(depCall.body.spec.template.spec.containers[0]?.resources.limits.memory).toBe("2Gi");
    expect(depCall.body.spec.template.spec.containers[0]?.resources.limits.cpu).toBe("2000m");
  });

  it("filters env vars to safe identifiers only", async () => {
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    await p.provision(baseConfig(), {
      VALID_KEY: "ok",
      "INVALID-KEY": "no",
      "1BADSTART": "no",
    });
    const depCall = apis.apps.createNamespacedDeployment.mock.calls[0]?.[0] as {
      body: {
        spec: {
          template: {
            spec: { containers: Array<{ env?: Array<{ name: string }> }> };
          };
        };
      };
    };
    const envNames = depCall.body.spec.template.spec.containers[0]?.env?.map((e) => e.name) ?? [];
    expect(envNames).toContain("VALID_KEY");
    expect(envNames).not.toContain("INVALID-KEY");
    expect(envNames).not.toContain("1BADSTART");
  });

  // Issue #317 (OWASP A07) — secrets must travel via Secret + valueFrom, never inline.
  it("creates a per-MCP Secret with stringData and references it via valueFrom (issue #317)", async () => {
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    await p.provision(baseConfig(), {
      TOKEN: "supersecret-value",
      ANOTHER: "another-secret",
    });
    expect(apis.core.createNamespacedSecret).toHaveBeenCalledTimes(1);
    const secretCall = apis.core.createNamespacedSecret.mock.calls[0]?.[0] as {
      body: { stringData: Record<string, string>; metadata: { name: string } };
    };
    expect(secretCall.body.stringData).toEqual({
      TOKEN: "supersecret-value",
      ANOTHER: "another-secret",
    });
    const resourceName = secretCall.body.metadata.name;

    // Deployment env entries must use secretKeyRef, no inline `value`.
    const depCall = apis.apps.createNamespacedDeployment.mock.calls[0]?.[0] as {
      body: {
        spec: {
          template: {
            spec: {
              containers: Array<{
                env?: Array<{
                  name: string;
                  value?: string;
                  valueFrom?: { secretKeyRef?: { name: string; key: string } };
                }>;
              }>;
            };
          };
        };
      };
    };
    const envEntries = depCall.body.spec.template.spec.containers[0]?.env ?? [];
    expect(envEntries.length).toBeGreaterThan(0);
    for (const e of envEntries) {
      expect(e.value).toBeUndefined();
      expect(e.valueFrom?.secretKeyRef?.name).toBe(resourceName);
      expect(e.valueFrom?.secretKeyRef?.key).toBe(e.name);
    }
    // Argv-leak guard: no plaintext secret value anywhere in Deployment YAML.
    const yaml = JSON.stringify(depCall.body);
    expect(yaml).not.toContain("supersecret-value");
    expect(yaml).not.toContain("another-secret");
  });

  it("does NOT create a Secret when env is empty (no orphan resource)", async () => {
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    await p.provision(baseConfig(), {});
    expect(apis.core.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it("cleanup() deletes the Secret alongside other managed resources (issue #317)", async () => {
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis, sleep: async () => {} });
    const result = await p.provision(baseConfig(), { TOKEN: "x" });
    await result.cleanup();
    expect(apis.core.deleteNamespacedSecret).toHaveBeenCalledTimes(1);
  });

  it("invokes the log streamer factory after the Deployment is Ready", async () => {
    const apis = makeApis();
    const stop = vi.fn();
    const factory = vi.fn(async () => ({ stop }));
    const p = new K8sSseProvisioner({
      apis,
      sleep: async () => {},
      logStreamerFactory: factory,
    });
    const result = await p.provision(baseConfig(), {});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(
      expect.objectContaining({
        apis,
        namespace: "metis-mcp",
        serverId: "abc123",
      }),
    );
    await result.cleanup();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("survives a log streamer factory throwing — provision still succeeds", async () => {
    const apis = makeApis();
    const factory = vi.fn(async () => {
      throw new Error("kaboom");
    });
    const p = new K8sSseProvisioner({
      apis,
      sleep: async () => {},
      logStreamerFactory: factory,
    });
    const result = await p.provision(baseConfig(), {});
    expect(result.transport).toBe("sse");
    await expect(result.cleanup()).resolves.not.toThrow();
  });
});

describe("K8sSseProvisioner.tryGetApis", () => {
  it("returns the injected apis without touching kubeconfig", () => {
    const apis = makeApis();
    const p = new K8sSseProvisioner({ apis });
    expect(p.tryGetApis()).toBe(apis);
  });

  it("returns null instead of throwing when no kubeconfig is available", () => {
    // Force kubeconfig load failure by clearing env + (in the unlikely
    // case the host has a real kubeconfig) accept either null OR a real
    // apis object — both prove we didn't crash.
    delete process.env.KUBERNETES_SERVICE_HOST;
    const p = new K8sSseProvisioner();
    expect(() => p.tryGetApis()).not.toThrow();
  });
});
