/**
 * #121 — the UNAUTHENTICATED deep health check (`/api/health/deep`, and the
 * same handler at `/readyz`) must never echo exception text.
 *
 * Kubelet probes `/readyz` without credentials, so the route stays public; what
 * changes is the body. Every failing check answers a fixed message, and the raw
 * error — which here carries a datasource path, a user name, a provider URL and
 * a kubeconfig context — reaches the server log and nothing else.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryRaw, snapshot, probe, logError, logWarn, scheduler, mcpRegistry } = vi.hoisted(() => ({
  mcpRegistry: vi.fn(),
  queryRaw: vi.fn(),
  snapshot: vi.fn(),
  probe: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  scheduler: vi.fn(),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: queryRaw,
    user: { upsert: vi.fn(async () => ({ id: "user_admin" })) },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("../src/lib/rag/embedder.js", () => ({
  getEmbedder: () => ({ snapshot }),
}));

vi.mock("../src/health/mcp-runtime-probe.js", () => ({
  probeMCPRuntime: probe,
}));

// Only the health route's registry lookup is replaced; the rest of the MCP
// module stays real so `createApp()` wires its routes as usual.
vi.mock("../src/lib/mcp/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/mcp/index.js")>()),
  getMCPRegistry: mcpRegistry,
}));

vi.mock("../src/lib/scheduler/index.js", () => ({
  getSchedulerBootstrap: scheduler,
}));

vi.mock("../src/lib/logger.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/lib/logger.js")>();
  return {
    ...orig,
    createChildLogger: (name: string) => {
      const real = orig.createChildLogger(name);
      if (name !== "health") return real;
      return { ...real, error: logError, warn: logWarn, info: vi.fn(), debug: vi.fn() };
    },
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import { HEALTH_CHECK_MESSAGES, setHealthProviderForTests } from "../src/routes/health.js";
import type { AIProvider } from "../src/lib/ai/index.js";

/** Secret-shaped fragments a raw error could carry. None may reach the body. */
const DB_ERROR =
  "Can't reach database server at `db.internal.example:5432` (user `metis_owner`, file /srv/metis/data/prod.db)";
const EMBED_ERROR = "connect ECONNREFUSED 10.20.30.40:5050 (https://embed.internal.example/v1)";
const MCP_ERROR = "registry list failed: sqlite /srv/metis/data/mcp.db locked by pid 4242";
const LEAKS = [
  "/srv/metis/data/mcp.db",
  "pid 4242",
  "db.internal.example",
  "metis_owner",
  "/srv/metis/data/prod.db",
  "10.20.30.40",
  "embed.internal.example",
  "ECONNREFUSED",
  "ctx-prod-cluster",
  "scheduler exploded at /opt/metis",
  "ai config exploded: key sk-ant-live",
];

let app: ReturnType<typeof createApp>;

beforeEach(() => {
  app = createApp();
  queryRaw.mockReset().mockResolvedValue(1);
  snapshot.mockReset().mockReturnValue({
    loaded: true,
    ok: true,
    status: "ok",
    backend: "xenova",
    model: "m",
    dimension: 8,
    fellBack: false,
    hashFallbackAllowed: false,
    error: null,
  });
  probe.mockReset().mockResolvedValue({
    status: "ok",
    runtime: "docker-stdio",
    checks: [{ name: "dockerSocket", status: "ok" }],
    generatedAt: 0,
  });
  mcpRegistry.mockReset().mockImplementation(() => {
    throw new Error("MCP registry not initialised");
  });
  scheduler.mockReset().mockImplementation(() => {
    throw new Error("not initialised");
  });
  logError.mockReset();
  logWarn.mockReset();
});

afterEach(() => {
  setHealthProviderForTests(null);
  delete process.env.AI_OFFLINE;
  delete process.env.AI_PROVIDER;
  delete process.env.ANTHROPIC_API_KEY;
});

function expectNoLeak(body: unknown): void {
  const text = JSON.stringify(body);
  for (const leak of LEAKS) expect(text, `body leaks "${leak}"`).not.toContain(leak);
}

describe.each(["/api/health/deep", "/readyz"])("%s never returns exception text (#121)", (path) => {
  it("database error → fixed message, raw error logged, 503", async () => {
    queryRaw.mockRejectedValue(new Error(DB_ERROR));
    // Unauthenticated on purpose: this is the caller the fix protects against.
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.checks.database).toEqual({
      status: "error",
      message: HEALTH_CHECK_MESSAGES.database,
    });
    expectNoLeak(res.body);
    expect(logError).toHaveBeenCalledWith(
      "Database health check failed",
      expect.objectContaining({ error: DB_ERROR }),
    );
  });

  it("embeddings load failure → fixed message, raw error logged, still 503", async () => {
    snapshot.mockReturnValue({
      loaded: false,
      ok: false,
      status: "error",
      backend: "sidecar",
      model: "m",
      dimension: 8,
      fellBack: false,
      hashFallbackAllowed: false,
      error: EMBED_ERROR,
    });
    const res = await request(app).get(path);
    expect(res.status).toBe(503);
    expect(res.body.checks.embeddings).toEqual({
      status: "error",
      message: HEALTH_CHECK_MESSAGES.embeddings,
    });
    expectNoLeak(res.body);
    expect(logError).toHaveBeenCalledWith(
      "Embeddings health check failed",
      expect.objectContaining({ error: EMBED_ERROR }),
    );
  });

  it("embedder module throwing → fixed message, raw error logged", async () => {
    snapshot.mockImplementation(() => {
      throw new Error(EMBED_ERROR);
    });
    const res = await request(app).get(path);
    expect(res.body.checks.embeddings).toEqual({
      status: "error",
      message: HEALTH_CHECK_MESSAGES.embeddings,
    });
    expectNoLeak(res.body);
    expect(logError).toHaveBeenCalledWith(
      "Embeddings health check failed",
      expect.objectContaining({ error: EMBED_ERROR }),
    );
  });

  it("scheduler, AI and MCP-runtime failures carry fixed messages too", async () => {
    // A health snapshot whose field access throws reaches the scheduler's outer catch.
    scheduler.mockImplementation(() => ({
      scheduler: {
        health: () => ({
          status: "ok",
          queueDepth: 0,
          running: 0,
          lastTickAt: null,
          get enabled(): boolean {
            throw new Error("scheduler exploded at /opt/metis");
          },
        }),
      },
    }));
    // Pull AI out of offline mode and make the provider ping throw.
    process.env.AI_OFFLINE = "false";
    process.env.AI_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    setHealthProviderForTests({
      name: "anthropic",
      ping: async () => {
        throw new Error("ai config exploded: key sk-ant-live");
      },
    } as unknown as AIProvider);
    probe.mockRejectedValue(new Error("kubeconfig ctx-prod-cluster unreadable"));

    const res = await request(app).get(path);
    expect(res.body.checks.scheduler).toEqual({
      status: "degraded",
      message: HEALTH_CHECK_MESSAGES.scheduler,
    });
    expect(res.body.checks.ai).toEqual({ status: "degraded", message: HEALTH_CHECK_MESSAGES.ai });
    expect(res.body.checks.mcpRuntime).toEqual({
      status: "degraded",
      message: HEALTH_CHECK_MESSAGES.mcpRuntime,
    });
    expectNoLeak(res.body);
    expect(logWarn).toHaveBeenCalledWith(
      "Scheduler health check failed",
      expect.objectContaining({ error: "scheduler exploded at /opt/metis" }),
    );
  });

  // Review of PR #259: the MCP-registry catch had no test, so reverting its
  // message to `errorText(err)` stayed green.
  it("MCP registry list() throwing → fixed message, raw error logged", async () => {
    mcpRegistry.mockImplementation(() => ({
      list: async () => {
        throw new Error(MCP_ERROR);
      },
    }));
    const res = await request(app).get(path);
    expect(res.body.checks.mcp).toEqual({
      status: "degraded",
      message: HEALTH_CHECK_MESSAGES.mcp,
    });
    expectNoLeak(res.body);
    expect(logWarn).toHaveBeenCalledWith(
      "MCP health check failed",
      expect.objectContaining({ error: MCP_ERROR }),
    );
  });

  it("getMCPRegistry() throwing omits the MCP check and echoes nothing", async () => {
    mcpRegistry.mockImplementation(() => {
      throw new Error(MCP_ERROR);
    });
    const res = await request(app).get(path);
    expect(res.body.checks.mcp).toBeUndefined();
    expectNoLeak(res.body);
  });

  it("a failing MCP runtime sub-check's detail stays in the log, not the body", async () => {
    probe.mockResolvedValue({
      status: "fail",
      runtime: "k8s-sse",
      checks: [
        { name: "dockerSocket", status: "skip", detail: "runtime=k8s-sse" },
        { name: "kubeconfig", status: "fail", detail: "context ctx-prod-cluster: ECONNREFUSED" },
      ],
      generatedAt: 0,
    });
    const res = await request(app).get(path);
    expect(res.body.checks.mcpRuntime).toEqual({
      status: "degraded",
      message: "dockerSocket=skip kubeconfig=fail",
    });
    expect(res.body.mcpRuntime.checks).toEqual([
      { name: "dockerSocket", status: "skip" },
      { name: "kubeconfig", status: "fail" },
    ]);
    expectNoLeak(res.body);
    expect(logWarn).toHaveBeenCalledWith(
      "MCP runtime probe failed",
      expect.objectContaining({
        checks: expect.arrayContaining([
          expect.objectContaining({ detail: "context ctx-prod-cluster: ECONNREFUSED" }),
        ]),
      }),
    );
  });
});
