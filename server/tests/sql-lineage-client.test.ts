/**
 * Tests for the `metis-sql-lineage` HTTP client — Epic #294 (#304).
 *
 * Mirrors embeddings-client.test.ts: a tiny local `node:http` server stands in
 * for the sidecar so we exercise the real undici request path (auth header,
 * retries, timeout, graceful degradation) WITHOUT Docker or a live service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const ORIGINAL = {
  token: process.env.SQL_LINEAGE_TOKEN,
  url: process.env.SQL_LINEAGE_URL,
  mode: process.env.SQL_LINEAGE_MODE,
  timeout: process.env.SQL_LINEAGE_TIMEOUT_MS,
  max: process.env.SQL_LINEAGE_MAX_ATTEMPTS,
  nodeEnv: process.env.NODE_ENV,
  vitest: process.env.VITEST,
  offline: process.env.AI_OFFLINE,
};

interface Handler {
  (
    path: string,
    body: string,
  ): { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

interface Probe {
  url: string;
  calls: { path: string; auth: string | undefined; body: string }[];
  close(): Promise<void>;
}

async function startProbe(handler: Handler): Promise<Probe> {
  const calls: Probe["calls"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      calls.push({ path: req.url ?? "", auth: req.headers.authorization, body });
      try {
        const result = await handler(req.url ?? "", body);
        res.writeHead(result.status, { "content-type": "application/json" });
        res.end(JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: (err as Error).message }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const EMPTY = { tables: [], columns: [], lineage_edges: [], uncertain: [], routines: [] };

beforeEach(() => {
  process.env.SQL_LINEAGE_TOKEN = "test-token";
  delete process.env.AI_OFFLINE;
  delete process.env.SQL_LINEAGE_TIMEOUT_MS;
  delete process.env.SQL_LINEAGE_MAX_ATTEMPTS;
  vi.resetModules();
});

afterEach(() => {
  for (const [k, key] of [
    ["token", "SQL_LINEAGE_TOKEN"],
    ["url", "SQL_LINEAGE_URL"],
    ["mode", "SQL_LINEAGE_MODE"],
    ["timeout", "SQL_LINEAGE_TIMEOUT_MS"],
    ["max", "SQL_LINEAGE_MAX_ATTEMPTS"],
    ["nodeEnv", "NODE_ENV"],
    ["vitest", "VITEST"],
    ["offline", "AI_OFFLINE"],
  ] as const) {
    const v = ORIGINAL[k];
    if (v === undefined) delete process.env[key];
    else process.env[key] = v;
  }
  vi.restoreAllMocks();
});

describe("SqlLineageClient", () => {
  it("requires a token", async () => {
    delete process.env.SQL_LINEAGE_TOKEN;
    const { SqlLineageClient } = await import("../src/lib/code-graph/sql-lineage-client.js");
    expect(() => new SqlLineageClient()).toThrow(/SQL_LINEAGE_TOKEN is required/);
  });

  it("sends the bearer token and schema, returns the parsed result", async () => {
    const probe = await startProbe((path, body) => {
      expect(path).toBe("/extract_usage");
      const parsed = JSON.parse(body);
      expect(parsed.schema).toEqual({ public: { users: { id: "INT" } } });
      return {
        status: 200,
        body: {
          tables: [
            { schema: "public", name: "users", qualifiedName: "public.users", access: "read" },
          ],
          columns: [],
          lineage_edges: [],
          uncertain: [],
        },
      };
    });
    try {
      const { SqlLineageClient } = await import("../src/lib/code-graph/sql-lineage-client.js");
      const client = new SqlLineageClient({ baseUrl: probe.url, token: "secret" });
      const res = await client.extractUsage({
        sql: "SELECT id FROM public.users",
        dialect: "postgres",
        schema: { public: { users: { id: "INT" } } },
      });
      expect(res.tables[0].qualifiedName).toBe("public.users");
      expect(probe.calls[0].auth).toBe("Bearer secret");
    } finally {
      await probe.close();
    }
  });

  it("retries on 5xx then succeeds", async () => {
    let n = 0;
    const probe = await startProbe(() => {
      n += 1;
      if (n < 2) return { status: 503, body: { error: "warming" } };
      return { status: 200, body: EMPTY };
    });
    try {
      const { SqlLineageClient } = await import("../src/lib/code-graph/sql-lineage-client.js");
      const client = new SqlLineageClient({ baseUrl: probe.url, token: "x", maxAttempts: 3 });
      const res = await client.extractUsage({ sql: "SELECT 1" });
      expect(res).toEqual(EMPTY);
      expect(n).toBe(2);
    } finally {
      await probe.close();
    }
  });

  it("throws SqlLineageClientError on 401 (no retry)", async () => {
    let n = 0;
    const probe = await startProbe(() => {
      n += 1;
      return { status: 401, body: { error: "unauthorized" } };
    });
    try {
      const { SqlLineageClient, SqlLineageClientError } =
        await import("../src/lib/code-graph/sql-lineage-client.js");
      const client = new SqlLineageClient({ baseUrl: probe.url, token: "x", maxAttempts: 3 });
      await expect(client.extractUsage({ sql: "SELECT 1" })).rejects.toBeInstanceOf(
        SqlLineageClientError,
      );
      expect(n).toBe(1); // 401 is not retryable
    } finally {
      await probe.close();
    }
  });

  it("healthz returns the status payload", async () => {
    const probe = await startProbe(() => ({
      status: 200,
      body: { status: "ok", tokenConfigured: true },
    }));
    try {
      const { SqlLineageClient } = await import("../src/lib/code-graph/sql-lineage-client.js");
      const client = new SqlLineageClient({ baseUrl: probe.url, token: "x" });
      const h = await client.healthz();
      expect(h.status).toBe("ok");
      expect(h.tokenConfigured).toBe(true);
    } finally {
      await probe.close();
    }
  });
});

describe("resolveSqlLineageMode", () => {
  it("honours explicit sidecar/in-process", async () => {
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    process.env.SQL_LINEAGE_MODE = "sidecar";
    expect(mod.resolveSqlLineageMode()).toBe("sidecar");
    process.env.SQL_LINEAGE_MODE = "in-process";
    expect(mod.resolveSqlLineageMode()).toBe("in-process");
  });

  it("defaults to in-process under test", async () => {
    delete process.env.SQL_LINEAGE_MODE;
    process.env.NODE_ENV = "test";
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    expect(mod.resolveSqlLineageMode()).toBe("in-process");
    expect(mod.isSqlLineageEnabled()).toBe(false);
  });

  it("is sidecar in production", async () => {
    delete process.env.SQL_LINEAGE_MODE;
    delete process.env.VITEST;
    delete process.env.AI_OFFLINE;
    process.env.NODE_ENV = "production";
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    expect(mod.resolveSqlLineageMode()).toBe("sidecar");
  });
});

describe("isSqlLineageEnabled (#894 per-project override)", () => {
  it("returns the override verbatim when true or false, ignoring the platform mode", async () => {
    process.env.SQL_LINEAGE_MODE = "in-process";
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    expect(mod.isSqlLineageEnabled(true)).toBe(true);
    process.env.SQL_LINEAGE_MODE = "sidecar";
    expect(mod.isSqlLineageEnabled(false)).toBe(false);
  });

  it("falls back to the platform default when the override is undefined/null", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    expect(mod.isSqlLineageEnabled()).toBe(true);
    expect(mod.isSqlLineageEnabled(undefined)).toBe(true);
    expect(mod.isSqlLineageEnabled(null)).toBe(true);
    process.env.SQL_LINEAGE_MODE = "in-process";
    expect(mod.isSqlLineageEnabled()).toBe(false);
  });
});

describe("isSqlLineageSidecarConfigured", () => {
  it("is true only when SQL_LINEAGE_TOKEN is a non-blank string", async () => {
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    delete process.env.SQL_LINEAGE_TOKEN;
    expect(mod.isSqlLineageSidecarConfigured()).toBe(false);
    process.env.SQL_LINEAGE_TOKEN = "   ";
    expect(mod.isSqlLineageSidecarConfigured()).toBe(false);
    process.env.SQL_LINEAGE_TOKEN = "shhh";
    expect(mod.isSqlLineageSidecarConfigured()).toBe(true);
  });
});

describe("extractUsageSafe (graceful degradation)", () => {
  it("returns null when the sidecar is disabled", async () => {
    process.env.SQL_LINEAGE_MODE = "in-process";
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    const res = await mod.extractUsageSafe({ sql: "SELECT 1" });
    expect(res).toBeNull();
  });

  it("returns null (never throws) when the sidecar errors", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const probe = await startProbe(() => ({ status: 500, body: { error: "boom" } }));
    try {
      const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
      const client = new mod.SqlLineageClient({ baseUrl: probe.url, token: "x", maxAttempts: 1 });
      const res = await mod.extractUsageSafe({ sql: "SELECT 1" }, client);
      expect(res).toBeNull();
    } finally {
      await probe.close();
    }
  });

  it("returns the result when the sidecar succeeds", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const probe = await startProbe(() => ({
      status: 200,
      body: {
        tables: [{ schema: "", name: "t", qualifiedName: "t", access: "read" }],
        columns: [],
        lineage_edges: [],
        uncertain: [],
      },
    }));
    try {
      const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
      const client = new mod.SqlLineageClient({ baseUrl: probe.url, token: "x" });
      const res = await mod.extractUsageSafe({ sql: "SELECT 1 FROM t" }, client);
      expect(res?.tables[0].name).toBe("t");
    } finally {
      await probe.close();
    }
  });

  it("builds its own client from env when none is passed", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const probe = await startProbe(() => ({
      status: 200,
      body: {
        tables: [],
        columns: [],
        lineage_edges: [],
        uncertain: [{ reason: "dynamic-reference", detail: "x" }],
      },
    }));
    process.env.SQL_LINEAGE_URL = probe.url;
    process.env.SQL_LINEAGE_TOKEN = "env-token";
    try {
      const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
      mod.__resetSqlLineageClientSingleton();
      const res = await mod.extractUsageSafe({ sql: "EXEC @x" });
      expect(res?.uncertain[0].reason).toBe("dynamic-reference");
    } finally {
      await probe.close();
    }
  });

  it("returns null (never throws) when no token is configured", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    delete process.env.SQL_LINEAGE_TOKEN;
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    mod.__resetSqlLineageClientSingleton();
    const res = await mod.extractUsageSafe({ sql: "SELECT 1" });
    expect(res).toBeNull();
  });

  it("#894 — an explicit enabledOverride=true forces extraction even when the platform mode is off", async () => {
    process.env.SQL_LINEAGE_MODE = "in-process";
    const probe = await startProbe(() => ({
      status: 200,
      body: {
        tables: [{ schema: "", name: "t", qualifiedName: "t", access: "read" }],
        columns: [],
        lineage_edges: [],
        uncertain: [],
      },
    }));
    try {
      const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
      const client = new mod.SqlLineageClient({ baseUrl: probe.url, token: "x" });
      const res = await mod.extractUsageSafe({ sql: "SELECT 1 FROM t" }, client, true);
      expect(res?.tables[0].name).toBe("t");
    } finally {
      await probe.close();
    }
  });

  it("#894 — an explicit enabledOverride=false forces skip even when the platform mode is sidecar", async () => {
    process.env.SQL_LINEAGE_MODE = "sidecar";
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    const res = await mod.extractUsageSafe({ sql: "SELECT 1" }, undefined, false);
    expect(res).toBeNull();
  });
});

describe("buildIntrospectedSchema (#317)", () => {
  it("maps introspected tables into the { db: { table: { col: type } } } shape", async () => {
    const { buildIntrospectedSchema } = await import("../src/lib/code-graph/sql-lineage-client.js");
    const schema = buildIntrospectedSchema([
      {
        schema: "public",
        name: "users",
        columns: [
          { name: "id", dataType: "integer" },
          { name: "email", dataType: "text" },
        ],
      },
    ]);
    expect(schema).toEqual({ public: { users: { id: "integer", email: "text" } } });
  });

  it("falls back to `public` when a table has no schema, and `unknown` for null types", async () => {
    const { buildIntrospectedSchema } = await import("../src/lib/code-graph/sql-lineage-client.js");
    const schema = buildIntrospectedSchema([
      { name: "orders", columns: [{ name: "total", dataType: null }] },
    ]);
    expect(schema).toEqual({ public: { orders: { total: "unknown" } } });
  });

  it("returns null for an empty table list (caller passes null → no regression)", async () => {
    const { buildIntrospectedSchema } = await import("../src/lib/code-graph/sql-lineage-client.js");
    expect(buildIntrospectedSchema([])).toBeNull();
  });
});

describe("buildIntrospectedSchemaFromSymbols (#901 column-level foundation)", () => {
  it("rebuilds the sqlglot schema from schema-graph table/column symbols", async () => {
    const { buildIntrospectedSchemaFromSymbols } =
      await import("../src/lib/code-graph/sql-lineage-client.js");
    const schema = buildIntrospectedSchemaFromSymbols([
      { kind: "table", qualifiedName: "sales.orders" },
      { kind: "column", qualifiedName: "sales.orders.id" },
      { kind: "column", qualifiedName: "sales.orders.total", columnType: "decimal" },
    ]);
    expect(schema).toEqual({ sales: { orders: { id: "unknown", total: "decimal" } } });
  });

  it("buckets schema-less identities under `public` (matches sqlglot's default namespace)", async () => {
    const { buildIntrospectedSchemaFromSymbols } =
      await import("../src/lib/code-graph/sql-lineage-client.js");
    const schema = buildIntrospectedSchemaFromSymbols([
      { kind: "table", qualifiedName: "users" },
      { kind: "column", qualifiedName: "users.email" },
    ]);
    expect(schema).toEqual({ public: { users: { email: "unknown" } } });
  });

  it("keeps a table with no columns as an empty bucket (so sqlglot still knows it exists)", async () => {
    const { buildIntrospectedSchemaFromSymbols } =
      await import("../src/lib/code-graph/sql-lineage-client.js");
    const schema = buildIntrospectedSchemaFromSymbols([
      { kind: "table", qualifiedName: "public.audit_log" },
    ]);
    expect(schema).toEqual({ public: { audit_log: {} } });
  });

  it("skips synthetic dynamic-placeholder names and malformed identities", async () => {
    const { buildIntrospectedSchemaFromSymbols } =
      await import("../src/lib/code-graph/sql-lineage-client.js");
    const schema = buildIntrospectedSchemaFromSymbols([
      { kind: "table", qualifiedName: "?dynamic:tablename" },
      { kind: "column", qualifiedName: "?dynamic:col" },
      { kind: "column", qualifiedName: "" },
      // A 4-segment column identity is not a shape the writer produces → skipped.
      { kind: "column", qualifiedName: "a.b.c.d" },
      { kind: "table", qualifiedName: "orders" },
    ]);
    expect(schema).toEqual({ public: { orders: {} } });
  });

  it("ignores non-schema symbol kinds (functions/classes) mixed into the rows", async () => {
    const { buildIntrospectedSchemaFromSymbols } =
      await import("../src/lib/code-graph/sql-lineage-client.js");
    const schema = buildIntrospectedSchemaFromSymbols([
      { kind: "function", qualifiedName: "src/x.ts::doThing" },
      { kind: "column", qualifiedName: "users.id" },
    ]);
    expect(schema).toEqual({ public: { users: { id: "unknown" } } });
  });

  it("returns null when no usable table/column symbols are present", async () => {
    const { buildIntrospectedSchemaFromSymbols } =
      await import("../src/lib/code-graph/sql-lineage-client.js");
    expect(buildIntrospectedSchemaFromSymbols([])).toBeNull();
    expect(
      buildIntrospectedSchemaFromSymbols([{ kind: "method", qualifiedName: "x.ts::m" }]),
    ).toBeNull();
  });
});

describe("normalizeExtractUsageResult (#316 back-compat)", () => {
  it("defaults a missing `routines` field (older sidecar) to []", async () => {
    const { normalizeExtractUsageResult } =
      await import("../src/lib/code-graph/sql-lineage-client.js");
    const out = normalizeExtractUsageResult({
      tables: [{ schema: "", name: "t", qualifiedName: "t", access: "read" }],
      columns: [],
      lineage_edges: [],
      uncertain: [],
      // routines intentionally omitted
    });
    expect(out.routines).toEqual([]);
    expect(out.tables).toHaveLength(1);
  });

  it("preserves a present `routines` field", async () => {
    const { normalizeExtractUsageResult } =
      await import("../src/lib/code-graph/sql-lineage-client.js");
    const out = normalizeExtractUsageResult({
      routines: [{ schema: "app", name: "do_sync", qualifiedName: "app.do_sync" }],
    });
    expect(out.routines).toEqual([
      { schema: "app", name: "do_sync", qualifiedName: "app.do_sync" },
    ]);
    expect(out.tables).toEqual([]);
  });
});

describe("extractUsage normalizes the response (#316)", () => {
  it("adds routines:[] when the sidecar omits it", async () => {
    const probe = await startProbe(() => ({
      status: 200,
      // Simulate an OLD sidecar response with no `routines` key.
      body: { tables: [], columns: [], lineage_edges: [], uncertain: [] },
    }));
    try {
      const { SqlLineageClient } = await import("../src/lib/code-graph/sql-lineage-client.js");
      const client = new SqlLineageClient({ baseUrl: probe.url, token: "x" });
      const res = await client.extractUsage({ sql: "SELECT 1" });
      expect(res.routines).toEqual([]);
    } finally {
      await probe.close();
    }
  });
});

describe("getSqlLineageClient singleton", () => {
  it("returns the same instance until reset", async () => {
    process.env.SQL_LINEAGE_TOKEN = "x";
    const mod = await import("../src/lib/code-graph/sql-lineage-client.js");
    mod.__resetSqlLineageClientSingleton();
    const a = mod.getSqlLineageClient();
    const b = mod.getSqlLineageClient();
    expect(a).toBe(b);
    mod.__resetSqlLineageClientSingleton();
    const c = mod.getSqlLineageClient();
    expect(c).not.toBe(a);
  });
});
