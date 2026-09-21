/**
 * MCP service — Prisma is mocked in-memory; lifecycle is stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// Issue #315 / #277 — control the user-scope feature flag + concurrency cap
// via a mocked ConfigService so we don't need a real settings table.
const cfgStore: Map<string, string | boolean | number> = new Map();
vi.mock("../src/lib/config/config-service.js", () => {
  return {
    getConfigService: () => ({
      get(key: string): string | null {
        const v = cfgStore.get(key);
        return v == null ? null : String(v);
      },
      getBool(key: string, fallback: boolean): boolean {
        const v = cfgStore.get(key);
        if (typeof v === "boolean") return v;
        if (typeof v === "string") return v === "true" || v === "1";
        return fallback;
      },
      getNumber(key: string, fallback: number): number {
        const v = cfgStore.get(key);
        if (typeof v === "number") return v;
        if (typeof v === "string") {
          const n = Number.parseInt(v, 10);
          return Number.isFinite(n) ? n : fallback;
        }
        return fallback;
      },
    }),
  };
});

interface Row {
  id: string;
  scope: string;
  projectId: string | null;
  label: string;
  transport: string;
  command: string | null;
  args: string | null;
  url: string | null;
  headers: string | null;
  envJson: string | null;
  envSecretId: string | null;
  envSecretRefs: string | null;
  trustLevel: string;
  defaultToolRisk: string;
  version: string | null;
  sha256: string | null;
  capabilities: string | null;
  status: string;
  lastHealthCheckAt: Date | null;
  latencyMs: number | null;
  failureCount: number;
  lastError: string | null;
  healthCheckIntervalSec: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  createdById: string | null;
}

const servers = new Map<string, Row>();
const allowlist = new Map<string, Set<string>>();
let next = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    /**
     * Issue #315 — `MCPRegistryService.createUserScopedAtomic` wraps the
     * count + create in `$transaction`. The mock implements an interactive
     * transaction by simply forwarding the same prisma object, which is
     * sufficient for the in-memory store below — there is no real DB to
     * isolate from. The per-user JS lock in MCPRegistryService is what
     * actually serializes concurrent calls in this test environment.
     */
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      // The mock prisma object is referenced via closure below; we
      // re-resolve it from the module here so the cb sees the same shape.
      const mod = await import("../src/lib/prisma.js");
      return cb(mod.prisma);
    }),
    mCPServer: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return [...servers.values()].filter((r) => {
          if (r.deletedAt) return false;
          for (const [k, v] of Object.entries(where ?? {})) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        }).length;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const r of servers.values()) {
          if (r.deletedAt) continue;
          let ok = true;
          for (const [k, v] of Object.entries(where)) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) ok = false;
          }
          if (ok) return r;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...servers.values()].filter((r) => {
          if (r.deletedAt) return false;
          for (const [k, v] of Object.entries(where ?? {})) {
            if (k === "deletedAt") continue;
            if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
          }
          return true;
        }),
      ),
      create: vi.fn(async ({ data }: { data: Partial<Row> }) => {
        next += 1;
        const row: Row = {
          id: `mcp_${next}`,
          envSecretId: null,
          version: null,
          sha256: null,
          capabilities: null,
          lastHealthCheckAt: null,
          latencyMs: null,
          failureCount: 0,
          lastError: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
          createdById: null,
          ...(data as Row),
        };
        servers.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
        const existing = servers.get(where.id);
        if (!existing) throw new Error("not found");
        const next = { ...existing, ...data, updatedAt: new Date() } as Row;
        servers.set(where.id, next);
        return next;
      }),
    },
    projectMCPAllowlist: {
      findMany: vi.fn(
        async ({
          where,
          include,
        }: {
          where: { projectId: string };
          include?: { mcpServer: boolean };
        }) => {
          const ids = [...(allowlist.get(where.projectId) ?? [])];
          return ids.map((mcpServerId) => ({
            projectId: where.projectId,
            mcpServerId,
            createdAt: new Date(),
            mcpServer: include?.mcpServer ? servers.get(mcpServerId) : undefined,
          }));
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: { projectId: string } }) => {
        allowlist.delete(where.projectId);
        return { count: 0 };
      }),
      createMany: vi.fn(
        async ({ data }: { data: Array<{ projectId: string; mcpServerId: string }> }) => {
          for (const d of data) {
            if (!allowlist.has(d.projectId)) allowlist.set(d.projectId, new Set());
            allowlist.get(d.projectId)!.add(d.mcpServerId);
          }
          return { count: data.length };
        },
      ),
    },
  },
}));

import { MCPLifecycleManager } from "../src/lib/mcp/lifecycle-manager.js";
import {
  MCPRegistryError,
  MCPRegistryService,
  normalizeRuntimeForConfig,
} from "../src/lib/mcp/mcp-service.js";

beforeEach(() => {
  servers.clear();
  allowlist.clear();
  next = 0;
  cfgStore.clear();
});

function makeService() {
  const lifecycle = new MCPLifecycleManager({
    resolveEnv: async (e) => e,
    transportFactory: () => ({
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined),
      closed: vi.fn(() => new Promise(() => undefined)),
      request: vi.fn(async (m: string) => {
        if (m === "initialize") return { protocolVersion: "2025-06-18" };
        return { tools: [] };
      }),
    }),
  });
  return new MCPRegistryService(lifecycle);
}

describe("MCPRegistryService", () => {
  it("creates and lists, masking plaintext env values", async () => {
    const svc = makeService();
    const created = await svc.create(
      {
        label: "demo",
        transport: "stdio",
        command: "node",
        env: { FOO: "plain", TOKEN: "${vault:t}" },
      },
      { id: "u1" },
    );
    expect(created.env).toEqual({ FOO: "***", TOKEN: "${vault:t}" });
    const list = await svc.list();
    expect(list).toHaveLength(1);
    expect(list[0].env?.FOO).toBe("***");
  });

  it("rejects duplicate label", async () => {
    const svc = makeService();
    await svc.create({ label: "dup", transport: "stdio", command: "node" }, { id: "u1" });
    await expect(
      svc.create({ label: "dup", transport: "stdio", command: "node" }, { id: "u1" }),
    ).rejects.toBeInstanceOf(MCPRegistryError);
  });

  it("update + remove flow", async () => {
    const svc = makeService();
    const c = await svc.create({ label: "x", transport: "stdio", command: "node" }, { id: "u1" });
    const u = await svc.update(c.id, { label: "x2", enabled: false }, { id: "u1" });
    expect(u.label).toBe("x2");
    expect(u.enabled).toBe(false);
    await svc.remove(c.id, { id: "u1" });
    expect(await svc.get(c.id)).toBeNull();
  });

  it("update returns 404 for unknown", async () => {
    const svc = makeService();
    await expect(svc.update("nope", { label: "x" }, { id: "u1" })).rejects.toThrow(/not found/);
  });

  it("setAllowList persists project mappings", async () => {
    const svc = makeService();
    const a = await svc.create({ label: "a", transport: "stdio", command: "node" }, { id: "u1" });
    const b = await svc.create({ label: "b", transport: "stdio", command: "node" }, { id: "u1" });
    const ids = await svc.setAllowList("proj1", [a.id, b.id, a.id], { id: "u1" });
    expect(ids.sort()).toEqual([a.id, b.id].sort());
  });

  it("listForProject returns project-scoped + globally-allowed", async () => {
    const svc = makeService();
    const global = await svc.create(
      { label: "g", transport: "stdio", command: "node", scope: "global" },
      { id: "u1" },
    );
    const local = await svc.create(
      {
        label: "p",
        transport: "stdio",
        command: "node",
        scope: "project",
        projectId: "proj1",
      },
      { id: "u1" },
    );
    expect(local.scope).toBe("project");
    await svc.setAllowList("proj1", [global.id], { id: "u1" });
    const items = await svc.listForProject("proj1");
    const labels = items.map((i) => i.label).sort();
    expect(labels).toEqual(["g", "p"]);
  });

  it("start persists status from lifecycle", async () => {
    const svc = makeService();
    const c = await svc.create({ label: "x", transport: "stdio", command: "node" }, { id: "u1" });
    const updated = await svc.start(c.id, { id: "u1" });
    expect(updated.status).toBe("ready");
  });

  it("stop returns idle status", async () => {
    const svc = makeService();
    const c = await svc.create({ label: "x", transport: "stdio", command: "node" }, { id: "u1" });
    await svc.start(c.id, { id: "u1" });
    const stopped = await svc.stop(c.id, { id: "u1" });
    expect(stopped.status).toBe("idle");
  });

  it("test reports ok=true for ready server", async () => {
    const svc = makeService();
    const c = await svc.create({ label: "x", transport: "stdio", command: "node" }, { id: "u1" });
    const r = await svc.test(c.id, { id: "u1" });
    expect(r.ok).toBe(true);
  });

  // Epic #272 / Sub-issue #287 — k8s-sse runtime forces transport='sse'.
  it("forces transport='sse' on create when runtime='k8s-sse'", async () => {
    const svc = makeService();
    const created = await svc.create(
      {
        label: "k8s",
        transport: "stdio", // user requested stdio, should be overridden.
        runtime: "k8s-sse",
        command: "ghcr.io/metis-mcps/uvx-runner-sse:1.0",
      },
      { id: "u1" },
    );
    expect(created.transport).toBe("sse");
    expect(created.runtime).toBe("k8s-sse");
  });

  it("forces transport='sse' on update when runtime promoted to k8s-sse", async () => {
    const svc = makeService();
    const c = await svc.create({ label: "x", transport: "stdio", command: "node" }, { id: "u1" });
    const u = await svc.update(c.id, { runtime: "k8s-sse" }, { id: "u1" });
    expect(u.transport).toBe("sse");
    expect(u.runtime).toBe("k8s-sse");
  });

  it("persists k8s-sse tunables on create", async () => {
    const svc = makeService();
    const created = await svc.create(
      {
        label: "k8s2",
        transport: "sse",
        runtime: "k8s-sse",
        command: "ghcr.io/metis-mcps/uvx-runner-sse:1.0",
        egressAllowlist: "host:api.github.com",
        k8sMemoryLimit: "1Gi",
        k8sCpuLimit: "500m",
        coldStart: true,
      },
      { id: "u1" },
    );
    expect(created.egressAllowlist).toBe("host:api.github.com");
    expect(created.k8sMemoryLimit).toBe("1Gi");
    expect(created.k8sCpuLimit).toBe("500m");
    expect(created.coldStart).toBe(true);
  });

  it("normalizes legacy stdio image commands to docker-stdio at start time", () => {
    expect(
      normalizeRuntimeForConfig({
        runtime: "native",
        transport: "stdio",
        command: "ghcr.io/metis-mcps/npx-runner:1.0.0",
      }),
    ).toBe("docker-stdio");
    expect(
      normalizeRuntimeForConfig({ runtime: "native", transport: "stdio", command: "npx" }),
    ).toBe("native");
  });
});

// Issue #315 (OWASP A04 / TOCTOU) — concurrent user-scope create() calls
// must respect the cap exactly. Before the fix, two parallel requests with
// `count == cap-1` would both observe `active < cap` and both succeed,
// exceeding the cap by one.
describe("MCPRegistryService.create — user-scope concurrency cap is atomic (issue #315)", () => {
  beforeEach(() => {
    cfgStore.set("MCP_ALLOW_USER_SCOPE", true);
  });

  it("admits exactly N when N+1 requests race", async () => {
    const cap = 3;
    cfgStore.set("MCP_USER_MAX_CONCURRENT", cap);
    const svc = makeService();
    const userId = "race-user";
    const attempts = cap + 2; // try to overshoot.

    const settled = await Promise.allSettled(
      Array.from({ length: attempts }, (_, i) =>
        svc.create(
          {
            label: `race-${i}`,
            transport: "stdio",
            command: "node",
            scope: "user",
          },
          { id: userId },
        ),
      ),
    );

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(fulfilled.length).toBe(cap);
    expect(rejected.length).toBe(attempts - cap);
    for (const r of rejected) {
      expect((r.reason as MCPRegistryError).code).toBe("USER_QUOTA_EXCEEDED");
    }
  });

  it("allows the next slot to open after a user removes one of their MCPs", async () => {
    const cap = 1;
    cfgStore.set("MCP_USER_MAX_CONCURRENT", cap);
    const svc = makeService();
    const userId = "u-recover";
    const first = await svc.create(
      { label: "a", transport: "stdio", command: "node", scope: "user" },
      { id: userId },
    );
    await expect(
      svc.create(
        { label: "b", transport: "stdio", command: "node", scope: "user" },
        { id: userId },
      ),
    ).rejects.toMatchObject({ code: "USER_QUOTA_EXCEEDED" });
    // Disable the first server (frees a slot) and try again.
    await svc.update(first.id, { enabled: false }, { id: userId });
    const second = await svc.create(
      { label: "c", transport: "stdio", command: "node", scope: "user" },
      { id: userId },
    );
    expect(second.label).toBe("c");
  });

  it("buckets are per-user — one user's cap doesn't starve another", async () => {
    const cap = 1;
    cfgStore.set("MCP_USER_MAX_CONCURRENT", cap);
    const svc = makeService();
    await svc.create(
      { label: "u1-a", transport: "stdio", command: "node", scope: "user" },
      { id: "user-A" },
    );
    // user-B should still be able to create — separate quota.
    const b = await svc.create(
      { label: "u2-a", transport: "stdio", command: "node", scope: "user" },
      { id: "user-B" },
    );
    expect(b.label).toBe("u2-a");
  });
});
