/**
 * Epic #272 / Sub-issue #289 — Cold-start reaper + wake-up unit tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfgStore = new Map<string, string | null>();
vi.mock("../src/lib/config/config-service.js", () => {
  const cfg = {
    get(key: string): string | null {
      return cfgStore.get(key) ?? null;
    },
    getNumber(key: string, fallback: number): number {
      const raw = cfgStore.get(key);
      if (raw == null) return fallback;
      const n = Number.parseInt(raw, 10);
      return Number.isFinite(n) ? n : fallback;
    },
    getBool(_key: string, fallback: boolean): boolean {
      return fallback;
    },
  };
  return {
    getConfigService: () => cfg,
    __resetConfigSingleton: () => undefined,
    ConfigService: class {},
    CONFIG_KEYS: {},
  };
});

const findMany = vi.fn();
const findFirst = vi.fn();
const update = vi.fn();
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    mCPServer: {
      findMany: (...a: unknown[]) => findMany(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

import {
  K8sColdStartReaper,
  makeColdStartWakeup,
  scaleDeployment,
} from "../src/lib/mcp/k8s-cold-start-reaper.js";

function makeApis(readyReplicas = 1) {
  return {
    apps: {
      readNamespacedDeployment: vi.fn(async () => ({
        spec: {},
        status: { readyReplicas },
      })),
      patchNamespacedDeployment: vi.fn(async () => ({})),
      createNamespacedDeployment: vi.fn(),
      deleteNamespacedDeployment: vi.fn(),
    },
    core: {
      createNamespacedService: vi.fn(),
      deleteNamespacedService: vi.fn(),
      createNamespacedServiceAccount: vi.fn(),
      deleteNamespacedServiceAccount: vi.fn(),
      readNamespacedService: vi.fn(),
    },
    networking: {
      createNamespacedNetworkPolicy: vi.fn(),
      deleteNamespacedNetworkPolicy: vi.fn(),
    },
  };
}

beforeEach(() => {
  cfgStore.clear();
  findMany.mockReset();
  findFirst.mockReset();
  update.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scaleDeployment", () => {
  it("issues a JSON-merge patch with the requested replica count", async () => {
    const apis = makeApis();
    await scaleDeployment(apis, "ns", "name", 0);
    expect(apis.apps.patchNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "name",
        namespace: "ns",
        body: { spec: { replicas: 0 } },
      }),
    );
  });
});

describe("K8sColdStartReaper.sweep", () => {
  it("no-ops when no apis are injected", async () => {
    const reaper = new K8sColdStartReaper({} as never);
    await expect(reaper.sweep()).resolves.toEqual({ scaled: 0, skipped: 0 });
  });

  it("scales eligible idle k8s-sse rows to zero and updates status to 'idle'", async () => {
    const apis = makeApis();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000); // 1h ago
    findMany.mockResolvedValueOnce([
      {
        id: "abc",
        runtime: "k8s-sse",
        coldStart: true,
        status: "ready",
        enabled: true,
        lastToolInvocationAt: longAgo,
        createdAt: longAgo,
      },
    ]);
    update.mockResolvedValueOnce({});
    const reaper = new K8sColdStartReaper({} as never, { apis });
    const result = await reaper.sweep();
    expect(result.scaled).toBe(1);
    expect(apis.apps.patchNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { spec: { replicas: 0 } },
      }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "idle" } }));
  });

  it("ignores rows that are not k8s-sse or not coldStart", async () => {
    const apis = makeApis();
    findMany.mockResolvedValueOnce([
      {
        id: "1",
        runtime: "native",
        coldStart: false,
        status: "ready",
        enabled: true,
        createdAt: new Date(0),
      },
      {
        id: "2",
        runtime: "k8s-sse",
        coldStart: false,
        status: "ready",
        enabled: true,
        createdAt: new Date(0),
      },
    ]);
    const reaper = new K8sColdStartReaper({} as never, { apis });
    const result = await reaper.sweep();
    expect(result.scaled).toBe(0);
    expect(result.skipped).toBe(2);
    expect(apis.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("skips rows that have been recently active", async () => {
    const apis = makeApis();
    findMany.mockResolvedValueOnce([
      {
        id: "abc",
        runtime: "k8s-sse",
        coldStart: true,
        status: "ready",
        enabled: true,
        lastToolInvocationAt: new Date(Date.now() - 60 * 1000), // 1 min ago
        createdAt: new Date(0),
      },
    ]);
    const reaper = new K8sColdStartReaper({} as never, { apis });
    const result = await reaper.sweep();
    expect(result.scaled).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("start()/stop() install + clear an interval timer", () => {
    vi.useFakeTimers();
    const apis = makeApis();
    findMany.mockResolvedValue([]);
    const reaper = new K8sColdStartReaper({} as never, { apis, intervalMs: 1_000 });
    reaper.start();
    reaper.start(); // idempotent
    reaper.stop();
    reaper.stop();
    vi.useRealTimers();
  });

  it("resolves apis lazily via apisProvider on each sweep", async () => {
    const apis = makeApis();
    findMany.mockResolvedValue([]);
    const provider = vi.fn(() => apis);
    const reaper = new K8sColdStartReaper({} as never, { apisProvider: provider });
    await reaper.sweep();
    await reaper.sweep();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("no-ops when apisProvider returns null", async () => {
    findMany.mockResolvedValue([]);
    const reaper = new K8sColdStartReaper({} as never, { apisProvider: () => null });
    const r = await reaper.sweep();
    expect(r).toEqual({ scaled: 0, skipped: 0 });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("makeColdStartWakeup", () => {
  it("scales to 1 + waits for ready when row is k8s-sse + coldStart + idle", async () => {
    const apis = makeApis(1);
    findFirst.mockResolvedValueOnce({
      id: "abc",
      runtime: "k8s-sse",
      coldStart: true,
      status: "idle",
    });
    update.mockResolvedValueOnce({});
    const wake = makeColdStartWakeup({ apis, sleep: async () => {} });
    await wake("abc");
    expect(apis.apps.patchNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ body: { spec: { replicas: 1 } } }),
    );
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: "ready" } }));
  });

  it("no-ops when row is not k8s-sse", async () => {
    const apis = makeApis(1);
    findFirst.mockResolvedValueOnce({
      id: "abc",
      runtime: "native",
      coldStart: false,
      status: "ready",
    });
    const wake = makeColdStartWakeup({ apis, sleep: async () => {} });
    await wake("abc");
    expect(apis.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("no-ops when status is already 'ready'", async () => {
    const apis = makeApis(1);
    findFirst.mockResolvedValueOnce({
      id: "abc",
      runtime: "k8s-sse",
      coldStart: true,
      status: "ready",
    });
    const wake = makeColdStartWakeup({ apis, sleep: async () => {} });
    await wake("abc");
    expect(apis.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("no-ops when the row no longer exists", async () => {
    const apis = makeApis(1);
    findFirst.mockResolvedValueOnce(null);
    const wake = makeColdStartWakeup({ apis, sleep: async () => {} });
    await wake("missing");
    expect(apis.apps.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("times out when readiness never arrives", async () => {
    const apis = makeApis(0);
    findFirst.mockResolvedValueOnce({
      id: "abc",
      runtime: "k8s-sse",
      coldStart: true,
      status: "idle",
    });
    let now = 0;
    const wake = makeColdStartWakeup({
      apis,
      timeoutMs: 10,
      now: () => now,
      sleep: async () => {
        now += 5;
      },
    });
    await expect(wake("abc")).rejects.toThrow(/COLD_START_WAKE_TIMEOUT/);
  });
});
