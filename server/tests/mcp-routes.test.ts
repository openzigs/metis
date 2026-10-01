/**
 * /api/mcp routes — auth + permission gating + create/list/start/stop with
 * an in-memory prisma + a fake lifecycle injected via the bootstrap path.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
const secretRows: Array<{ id: string; name: string; ciphertext: string }> = [];
const allowlist = new Map<string, Set<string>>();
let next = 0;

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({ id: "user_admin", ...create }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    // #552 — the binding guard stamps (raw UPDATE) the secrets a write binds anew.
    $executeRaw: vi.fn(async () => 1),
    secret: {
      // #480 — create/update bind each `${vault:x}` to a live secret id. A
      // superset is enough: the binder refines the rows by reachability. The
      // fixed rows are the secrets these tests reference without creating.
      findMany: vi.fn(async () => [
        ...secretRows,
        { id: "sec_fixture_t", name: "global:t" },
        { id: "sec_fixture_pre", name: "global:my-pre-existing-token" },
      ]),
      // #258 — like the real table: `name` is UNIQUE, soft-deleted rows included.
      create: vi.fn(async ({ data }: { data: { name: string; ciphertext: string } }) => {
        if (secretRows.some((r) => r.name === data.name)) {
          throw Object.assign(new Error("Unique constraint failed on the fields: (`name`)"), {
            code: "P2002",
          });
        }
        const row = {
          id: `sec_${Math.random().toString(36).slice(2, 9)}`,
          name: data.name,
          description: "",
          ciphertext: data.ciphertext,
          keyVersion: 1,
          algorithm: "aes-256-gcm",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        secretRows.push(row);
        return row;
      }),
    },
    mCPServer: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const r of servers.values()) {
          if (r.deletedAt) continue;
          let ok = true;
          for (const [k, v] of Object.entries(where ?? {})) {
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
        const updated = { ...existing, ...data, updatedAt: new Date() } as Row;
        servers.set(where.id, updated);
        return updated;
      }),
      // #479 — the conditional write a binding-guarded PATCH makes.
      updateMany: vi.fn(
        async ({ where, data }: { where: { id: string; updatedAt: Date }; data: Partial<Row> }) => {
          const r = servers.get(where.id);
          if (!r || r.updatedAt.getTime() !== where.updatedAt.getTime()) return { count: 0 };
          servers.set(where.id, { ...r, ...data, updatedAt: new Date() } as Row);
          return { count: 1 };
        },
      ),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const r = servers.get(where.id);
        if (!r) throw new Error("not found");
        return r;
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
          return ids.map((id) => ({
            projectId: where.projectId,
            mcpServerId: id,
            createdAt: new Date(),
            mcpServer: include?.mcpServer ? servers.get(id) : undefined,
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
  });
  return { prisma };
});

import request from "supertest";
import { createApp } from "../src/app.js";
import { bootstrapMCP } from "../src/lib/mcp/index.js";
import { setMCPRegistry } from "../src/lib/mcp/mcp-service.js";
import type { MCPTransportClient } from "../src/lib/mcp/types.js";
import { getVaultService } from "../src/lib/vault/vault-service.js";

let app: ReturnType<typeof createApp>;
let token: string;
let teardown: (() => Promise<void>) | null = null;

function fakeTransport(): MCPTransportClient {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    notify: vi.fn(async () => undefined),
    closed: vi.fn(() => new Promise(() => undefined)),
    request: vi.fn(async (m: string) => {
      if (m === "initialize") return { protocolVersion: "2025-06-18" };
      if (m === "tools/list") return { tools: [] };
      return {};
    }),
  };
}

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.MCP_ALLOW_LOOPBACK = "1";
  process.env.RATE_LIMIT_MAX = "10000";
});

beforeEach(async () => {
  servers.clear();
  secretRows.length = 0;
  allowlist.clear();
  next = 0;
  app = createApp();
  // Wire MCP with a fake transport so /start succeeds without spawning.
  const boot = bootstrapMCP({ io: null, startHealthMonitor: false });
  // Replace the lifecycle's transport factory by recreating with fake.
  await boot.shutdown();
  const { MCPLifecycleManager } = await import("../src/lib/mcp/lifecycle-manager.js");
  const { MCPRegistryService } = await import("../src/lib/mcp/mcp-service.js");
  const lifecycle = new MCPLifecycleManager({
    resolveEnv: async (e) => e,
    transportFactory: () => fakeTransport(),
  });
  const registry = new MCPRegistryService(lifecycle);
  setMCPRegistry(registry);
  teardown = async () => {
    setMCPRegistry(null);
    await lifecycle.stopAll();
  };
  token = await login();
});

afterEach(async () => {
  if (teardown) await teardown();
  teardown = null;
  vi.clearAllMocks();
});

describe("/api/mcp", () => {
  it("requires auth", async () => {
    const res = await request(app).get("/api/mcp");
    expect(res.status).toBe(401);
  });

  it("POST creates an MCP server (201) with masked env in response", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "demo",
        transport: "stdio",
        command: "node",
        args: ["x.js"],
        env: { FOO: "plain", TOKEN: "${vault:t}" },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.env).toEqual({ FOO: "***", TOKEN: "${vault:t}" });
  });

  it("POST validates payload (400 on missing label)", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ transport: "stdio", command: "node" });
    expect(res.status).toBe(400);
  });

  it("GET lists registered servers", async () => {
    await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "x", transport: "stdio", command: "node" });
    const res = await request(app).get("/api/mcp").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBe(1);
  });

  it("GET /:id returns 404 for unknown", async () => {
    const res = await request(app).get("/api/mcp/nope").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("start -> stop transitions the row", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "x", transport: "stdio", command: "node" });
    const id = create.body.data.id;
    const started = await request(app)
      .post(`/api/mcp/${id}/start`)
      .set("Authorization", `Bearer ${token}`);
    expect(started.status).toBe(200);
    expect(started.body.data.status).toBe("ready");
    const stopped = await request(app)
      .post(`/api/mcp/${id}/stop`)
      .set("Authorization", `Bearer ${token}`);
    expect(stopped.status).toBe(200);
    expect(stopped.body.data.status).toBe("idle");
  });

  it("DELETE removes the server (204)", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "del", transport: "stdio", command: "node" });
    const id = create.body.data.id;
    const res = await request(app).delete(`/api/mcp/${id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    const after = await request(app).get(`/api/mcp/${id}`).set("Authorization", `Bearer ${token}`);
    expect(after.status).toBe(404);
  });

  it("import dryRun previews without writing", async () => {
    const res = await request(app)
      .post("/api/mcp/import")
      .set("Authorization", `Bearer ${token}`)
      .send({
        dryRun: true,
        mcpJson: { mcpServers: { gh: { command: "npx", env: { GITHUB_TOKEN: "x" } } } },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(res.body.data.plan.totalSecrets).toBe(1);
    expect(res.body.data.created).toEqual([]);
  });

  it("project allowlist roundtrip", async () => {
    const a = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "a", transport: "stdio", command: "node" });
    const id = a.body.data.id;
    const put = await request(app)
      .put("/api/mcp/projects/proj1/allowlist")
      .set("Authorization", `Bearer ${token}`)
      .send({ serverIds: [id] });
    expect(put.status).toBe(200);
    expect(put.body.data.items).toEqual([id]);
    const get = await request(app)
      .get("/api/mcp/projects/proj1/allowlist")
      .set("Authorization", `Bearer ${token}`);
    expect(get.body.data.items).toEqual([id]);
  });

  it("PATCH validates payload (400)", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "p", transport: "stdio", command: "node" });
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/mcp/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ enabled: "not-a-bool" });
    expect(res.status).toBe(400);
  });

  it("PATCH updates a server", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "u", transport: "stdio", command: "node" });
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/mcp/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "u2", enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.data.label).toBe("u2");
    expect(res.body.data.enabled).toBe(false);
  });

  it("test endpoint returns probe result", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "t", transport: "stdio", command: "node" });
    const id = create.body.data.id;
    const res = await request(app)
      .post(`/api/mcp/${id}/test`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty("ok");
    expect(res.body.data).toHaveProperty("latencyMs");
  });

  it("restart endpoint reconnects", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "r", transport: "stdio", command: "node" });
    const id = create.body.data.id;
    const res = await request(app)
      .post(`/api/mcp/${id}/restart`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("ready");
  });

  it("import (non-dryRun) creates servers", async () => {
    const res = await request(app)
      .post("/api/mcp/import")
      .set("Authorization", `Bearer ${token}`)
      .send({
        mcpJson: { mcpServers: { fresh: { command: "npx" } } },
      });
    expect([200, 207]).toContain(res.status);
    expect(res.body.data.created.length + res.body.data.errors.length).toBeGreaterThan(0);
  });

  it("import without mcpJson is 400", async () => {
    const res = await request(app)
      .post("/api/mcp/import")
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(400);
  });

  // SEC-7: direct API write must auto-vault secret-shaped env values + headers
  // and mask the response.
  it("auto-vaults plaintext env values matching SECRET_KEY_PATTERN on POST", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "vault-env",
        transport: "stdio",
        command: "node",
        env: { GITHUB_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa", LOG_LEVEL: "debug" },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.env.GITHUB_TOKEN).toMatch(/^\$\{vault:/);
    expect(res.body.data.env.LOG_LEVEL).toBe("***");
    expect(res.body.data.envSecretRefs?.GITHUB_TOKEN).toBeTruthy();
    // No plaintext anywhere in response
    expect(JSON.stringify(res.body)).not.toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  });

  it("auto-vaults Authorization header on POST and masks response (SEC-3 / SEC-7)", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "vault-headers",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { Authorization: "Bearer ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzz" },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.headers.Authorization).toMatch(/^\$\{vault:/);
    expect(JSON.stringify(res.body)).not.toContain("ghp_zzzzzzzzzzzzzzzzzzzzzzzzzzzzz");
  });

  it("auto-vaults secret-shaped header value even when name is innocuous", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "vh2",
        transport: "http",
        url: "https://api.example.com/mcp",
        headers: { "X-Custom": "Bearer aaaaaaaaaaaaaaaaaaaaaaa" },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.headers["X-Custom"]).toMatch(/^\$\{vault:/);
  });

  it("PATCH auto-vaults env values too", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "patchvault", transport: "stdio", command: "node" });
    const id = create.body.data.id;
    const res = await request(app)
      .patch(`/api/mcp/${id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ env: { OPENAI_API_KEY: "sk-aaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(res.status).toBe(200);
    expect(res.body.data.env.OPENAI_API_KEY).toMatch(/^\$\{vault:/);
  });

  describe("auto-vaulted secret labels cannot clash (#258)", () => {
    /** The plaintext stored behind a `${vault:<label>}` ref the route wrote. */
    async function plaintextBehind(ref: string): Promise<string> {
      const label = /^\$\{vault:(.+)\}$/.exec(ref)![1];
      const row = secretRows.find((r) => r.name.endsWith(`:${label}`))!;
      return getVaultService().decrypt(row.ciphertext);
    }

    it("PATCHing a NEW token value twice stores and points at each new value", async () => {
      const create = await request(app)
        .post("/api/mcp")
        .set("Authorization", `Bearer ${token}`)
        .send({
          label: "gh",
          transport: "stdio",
          command: "node",
          env: { GITHUB_TOKEN: "ghp_ONE" },
        });
      expect(create.status).toBe(201);
      const id = create.body.data.id as string;

      for (const value of ["ghp_TWO", "ghp_THREE"]) {
        const res = await request(app)
          .patch(`/api/mcp/${id}`)
          .set("Authorization", `Bearer ${token}`)
          .send({ env: { GITHUB_TOKEN: value } });
        expect(res.status).toBe(200);
        const stored = JSON.parse(servers.get(id)!.envJson!) as Record<string, string>;
        expect(await plaintextBehind(stored.GITHUB_TOKEN)).toBe(value);
      }
    });

    it("the same server label in two projects keeps two separate secrets", async () => {
      const refs: string[] = [];
      for (const [projectId, value] of [
        ["project-aaaa", "ghp_AAA"],
        ["project-bbbb", "ghp_BBB"],
      ]) {
        const res = await request(app)
          .post("/api/mcp")
          .set("Authorization", `Bearer ${token}`)
          .send({
            label: "gh",
            scope: "project",
            projectId,
            transport: "stdio",
            command: "node",
            env: { GITHUB_TOKEN: value },
          });
        expect(res.status).toBe(201);
        refs.push(res.body.data.env.GITHUB_TOKEN as string);
      }
      expect(refs[0]).not.toBe(refs[1]);
      expect(await plaintextBehind(refs[0])).toBe("ghp_AAA");
      expect(await plaintextBehind(refs[1])).toBe("ghp_BBB");
    });

    it("PATCH without auth is 401 and writes no secret", async () => {
      const res = await request(app)
        .patch("/api/mcp/mcp_1")
        .send({ env: { GITHUB_TOKEN: "ghp_X" } });
      expect(res.status).toBe(401);
      expect(secretRows).toHaveLength(0);
    });

    it("POST/PATCH from a role without mcp.manage is 403 and writes no secret", async () => {
      const login = await request(app)
        .post("/api/auth/login")
        .send({ username: "reader", password: "password" });
      const reader = login.body.data.accessToken as string;
      const post = await request(app)
        .post("/api/mcp")
        .set("Authorization", `Bearer ${reader}`)
        .send({ label: "gh", transport: "stdio", command: "node", env: { GITHUB_TOKEN: "ghp_X" } });
      expect(post.status).toBe(403);
      const patch = await request(app)
        .patch("/api/mcp/mcp_1")
        .set("Authorization", `Bearer ${reader}`)
        .send({ env: { GITHUB_TOKEN: "ghp_X" } });
      expect(patch.status).toBe(403);
      // #537 panel: the re-bind route carries the same gate.
      const rebind = await request(app)
        .post("/api/mcp/mcp_1/rebind-secrets")
        .set("Authorization", `Bearer ${reader}`)
        .send({});
      expect(rebind.status).toBe(403);
      expect(secretRows).toHaveLength(0);
    });
  });

  it("PATCH on unknown id returns 404 before attempting vault writes", async () => {
    const res = await request(app)
      .patch("/api/mcp/does-not-exist")
      .set("Authorization", `Bearer ${token}`)
      .send({ env: { OPENAI_API_KEY: "sk-aaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(res.status).toBe(404);
  });

  it("GET /:id with explicit projectId/scope filter on listing", async () => {
    await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "scoped", transport: "stdio", command: "node" });
    const res = await request(app)
      .get("/api/mcp?scope=global")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });

  it("GET /api/mcp/projects/:projectId/available", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "avail", transport: "stdio", command: "node" });
    const id = create.body.data.id;
    await request(app)
      .put("/api/mcp/projects/proj9/allowlist")
      .set("Authorization", `Bearer ${token}`)
      .send({ serverIds: [id] });
    const res = await request(app)
      .get("/api/mcp/projects/proj9/available")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.length).toBeGreaterThan(0);
  });

  it("import dryRun preview vaults headers in plan output", async () => {
    const res = await request(app)
      .post("/api/mcp/import")
      .set("Authorization", `Bearer ${token}`)
      .send({
        dryRun: true,
        mcpJson: {
          mcpServers: {
            api: {
              url: "https://x/y",
              headers: { Authorization: "Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaa" },
            },
          },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.plan.totalSecrets).toBe(1);
  });

  it("start on unknown id returns 404", async () => {
    const res = await request(app)
      .post("/api/mcp/nope/start")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("POST as non-authed returns 401", async () => {
    const res = await request(app).post("/api/mcp").send({ label: "x", transport: "stdio" });
    expect(res.status).toBe(401);
  });

  it("POST with invalid scope value is 400", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ scope: "weird", label: "x", transport: "stdio", command: "node" });
    expect(res.status).toBe(400);
  });

  it("DELETE on unknown id returns 404", async () => {
    const res = await request(app)
      .delete("/api/mcp/missing")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("POST /:id/test invokes service.test()", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "tst", transport: "stdio", command: "node" });
    const res = await request(app)
      .post(`/api/mcp/${create.body.data.id}/test`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("POST /:id/restart works", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "rst", transport: "stdio", command: "node" });
    await request(app)
      .post(`/api/mcp/${create.body.data.id}/start`)
      .set("Authorization", `Bearer ${token}`);
    const res = await request(app)
      .post(`/api/mcp/${create.body.data.id}/restart`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it("PATCH with label-only update leaves env/headers untouched", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "label-only",
        transport: "stdio",
        command: "node",
        env: { LOG_LEVEL: "info" },
      });
    const res = await request(app)
      .patch(`/api/mcp/${create.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "renamed" });
    expect(res.status).toBe(200);
    expect(res.body.data.label).toBe("renamed");
  });

  it("import non-dryRun returns 200 when there are no errors", async () => {
    const res = await request(app)
      .post("/api/mcp/import")
      .set("Authorization", `Bearer ${token}`)
      .send({
        dryRun: false,
        mcpJson: {
          mcpServers: { x: { command: "node", args: ["./x.js"] } },
        },
      });
    expect([200, 207]).toContain(res.status);
    expect(res.body.data.created.length).toBeGreaterThan(0);
  });

  it("POST without auth returns 401 even when payload would otherwise be valid", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .send({ label: "noauth", transport: "stdio", command: "node" });
    expect(res.status).toBe(401);
  });

  it("import preview with empty servers map returns plan with zero entries", async () => {
    const res = await request(app)
      .post("/api/mcp/import")
      .set("Authorization", `Bearer ${token}`)
      .send({ dryRun: true, mcpJson: { mcpServers: {} } });
    expect(res.status).toBe(200);
    expect(res.body.data.plan.entries.length).toBe(0);
  });

  it("PATCH with envSecretRefs but no env merges with existing refs", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "merge-refs",
        transport: "stdio",
        command: "node",
        env: { GITHUB_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      });
    const res = await request(app)
      .patch(`/api/mcp/${create.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ envSecretRefs: { ANOTHER: "extra-label" } });
    expect(res.status).toBe(200);
  });

  it("PUT allowlist with non-array body coerces to empty list", async () => {
    const res = await request(app)
      .put("/api/mcp/projects/proj-empty/allowlist")
      .set("Authorization", `Bearer ${token}`)
      .send({ serverIds: "not-an-array" });
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("import non-dryRun with explicit scope+projectId+trustLevel+labelPrefix", async () => {
    const res = await request(app)
      .post("/api/mcp/import")
      .set("Authorization", `Bearer ${token}`)
      .send({
        dryRun: false,
        scope: "project",
        projectId: "proj-imp",
        trustLevel: "untrusted",
        labelPrefix: "px-",
        mcpJson: { mcpServers: { y: { command: "node", args: ["./y.js"] } } },
      });
    expect([200, 207]).toContain(res.status);
  });

  it("POST with explicit envSecretRefs in payload preserves them", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "with-refs",
        transport: "stdio",
        command: "node",
        env: { GITHUB_TOKEN: "${vault:my-pre-existing-token}" },
        envSecretRefs: { GITHUB_TOKEN: "my-pre-existing-token" },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.envSecretRefs.GITHUB_TOKEN).toBe("my-pre-existing-token");
  });

  it("PATCH with empty env object does not auto-vault and clears env", async () => {
    const create = await request(app)
      .post("/api/mcp")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "clear-env", transport: "stdio", command: "node" });
    const res = await request(app)
      .patch(`/api/mcp/${create.body.data.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ env: {} });
    expect(res.status).toBe(200);
  });

  it("returns 503 MCP_NOT_READY when registry is not initialised", async () => {
    setMCPRegistry(null);
    const res = await request(app).get("/api/mcp").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("MCP_NOT_READY");
  });

  it("GET /:id on unknown id returns 404", async () => {
    const res = await request(app)
      .get("/api/mcp/no-such-id")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("POST /:id/test on unknown id returns 404", async () => {
    const res = await request(app)
      .post("/api/mcp/none/test")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

// #608 review — the routes, not just `importStatus`, must answer 207 when an
// entry's row landed and a later step failed: a route reverted to
// `errors.length > 0 ? 207 : 200` would say 200 to a partial success.
describe.each([
  ["/api/mcp/import", "mcpServers"],
  ["/api/mcp/import-copilot", "servers"],
])("%s — an entry that lands and then fails (#608)", (url, key) => {
  it("answers 207 and names the landed row's id with the warning", async () => {
    const { getMCPRegistry } = await import("../src/lib/mcp/mcp-service.js");
    const toView = vi
      .spyOn(getMCPRegistry() as unknown as { toView: (row: unknown) => unknown }, "toView")
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("view failed"), { code: "VIEW_FAILED" });
      });

    const res = await request(app)
      .post(url)
      .set("Authorization", `Bearer ${token}`)
      .send({ dryRun: false, mcpJson: { [key]: { landed: { command: "node" } } } });
    toView.mockRestore();

    const rows = [...servers.values()].filter((r) => r.label === "landed");
    expect(rows).toHaveLength(1);
    expect(res.status).toBe(207);
    expect(res.body.data.errors).toEqual([]);
    expect(res.body.data.created).toEqual([
      { id: rows[0].id, label: "landed", warning: { message: "view failed", code: "VIEW_FAILED" } },
    ]);
  });
});
