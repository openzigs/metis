/**
 * #308: every production dispatcher factory, driven by Node's BUILT-IN
 * `fetch` over a real loopback socket.
 *
 * The existing suites for these call sites inject a fake dispatcher or a fake
 * `fetch`, so they stayed green on the undici 8 bump (#10) while the real
 * transport failed on every request (`invalid onRequestStart method`). Each
 * test here uses the call site's OWN default factory and the real global
 * `fetch`. Only host validation is stubbed, because it rightly refuses
 * loopback.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: { auditLog: { create: vi.fn(async () => ({})) } },
}));
vi.mock("../../../src/lib/connectors/network-allowlist.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/connectors/network-allowlist.js")>();
  return {
    ...actual,
    // Loopback is (correctly) refused by the real check; pin to it instead.
    resolveAndAssertConnectorHost: vi.fn(async (host: string) => ({
      hostname: host,
      address: "127.0.0.1",
      family: 4 as const,
    })),
  };
});

const { makePinnedDispatcher: connectorPinned, resolveConnectorDispatcher } =
  await import("../../../src/lib/connectors/network-allowlist.js");
const { makePinnedDispatcher: finopsPinned } =
  await import("../../../src/lib/finops/channels/webhook-sender.js");
const { safeFetch } = await import("../../../src/lib/net/safe-fetch.js");
const { createHttpWebhookHandler, loadWebhookConfig } =
  await import("../../../src/lib/scheduler/webhook-handler.js");
const { createImporter } = await import("../../../src/lib/importers/registry.js");
const { createProxyFetch } = await import("../../../src/lib/rag/backends/proxy-fetch.js");
const { proxyFetch } = await import("../../../src/lib/analysis/web-research-augmenter.js");

type Init = RequestInit & { dispatcher?: unknown };

const PROXY_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];
const savedEnv: Record<string, string | undefined> = {};
const servers: http.Server[] = [];

beforeEach(() => {
  for (const k of PROXY_ENV) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(async () => {
  for (const k of PROXY_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

interface Target {
  port: number;
  hits: { method?: string; url?: string; host?: string; body: string }[];
}

/** A loopback server answering every request with `reply` (JSON). */
async function target(reply: unknown = { ok: true }): Promise<Target> {
  const hits: Target["hits"] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      hits.push({ method: req.method, url: req.url, host: req.headers.host, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as AddressInfo).port, hits };
}

/**
 * A loopback forward proxy that serves ONE destination, `targetPort`. It
 * records the absolute-form request line undici sends for an http:// target
 * and relays the request to the fixed test target. Anything else is refused.
 */
async function forwardProxy(targetPort: number): Promise<{ url: string; seen: string[] }> {
  const seen: string[] = [];
  const origin = `http://127.0.0.1:${targetPort}`;
  const proxy = http.createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    if (!req.url?.startsWith(`${origin}/`)) {
      res.writeHead(403).end();
      return;
    }
    const up = http.request(
      { host: "127.0.0.1", port: targetPort, path: "/", method: req.method, headers: req.headers },
      (u) => {
        res.writeHead(u.statusCode ?? 502, u.headers);
        u.pipe(res);
      },
    );
    req.pipe(up);
  });
  servers.push(proxy);
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, seen };
}

const pinnedLoopback = (hostname: string) => ({
  hostname,
  address: "127.0.0.1",
  family: 4 as const,
});

describe("pinned dispatchers reach a real server through the built-in fetch", () => {
  it("connectors: makePinnedDispatcher (Jira raw fetch)", async () => {
    const t = await target();
    const d = await connectorPinned(pinnedLoopback("jira.metis.invalid"));
    const res = await globalThis.fetch(`http://jira.metis.invalid:${t.port}/rest`, {
      dispatcher: d,
    } as Init);
    expect(await res.json()).toEqual({ ok: true });
    expect(t.hits[0]?.host).toBe(`jira.metis.invalid:${t.port}`);
    await d.close?.();
  });

  it("connectors: resolveConnectorDispatcher without a proxy is the pinned agent", async () => {
    const t = await target();
    const d = await resolveConnectorDispatcher(pinnedLoopback("repo.metis.invalid"));
    const res = await globalThis.fetch(`http://repo.metis.invalid:${t.port}/`, {
      dispatcher: d,
    } as Init);
    expect(res.status).toBe(200);
    await d.close?.();
  });

  it("finops webhook: makePinnedDispatcher", async () => {
    const t = await target();
    const d = await finopsPinned(pinnedLoopback("hook.metis.invalid"));
    const res = await globalThis.fetch(`http://hook.metis.invalid:${t.port}/alert`, {
      method: "POST",
      body: "{}",
      dispatcher: d,
    } as Init);
    expect(res.status).toBe(200);
    expect(t.hits[0]?.method).toBe("POST");
    await d.close?.();
  });

  it("safeFetch: its default dispatcher factory", async () => {
    const t = await target({ safe: true });
    const res = await safeFetch(`http://127.0.0.1:${t.port}/x`, { allowLoopback: true });
    expect(await res.json()).toEqual({ safe: true });
    expect(t.hits).toHaveLength(1);
  });

  it("scheduler webhook task: its default dispatcher factory", async () => {
    const t = await target();
    const handler = createHttpWebhookHandler({
      config: loadWebhookConfig({ WEBHOOK_ALLOWED_HOSTS: "task.metis.invalid" }),
      resolveHost: async (host) => pinnedLoopback(host),
    });
    const ctx = {
      task: { payload: { url: `http://task.metis.invalid:${t.port}/go`, body: { a: 1 } } },
      signal: new AbortController().signal,
      reportProgress: vi.fn(),
      log: vi.fn(),
    } as unknown as Parameters<typeof handler>[0];
    await handler(ctx);
    expect(t.hits).toHaveLength(1);
    expect(t.hits[0]?.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("importers: the registry's production pinning factory", async () => {
    const t = await target({ data: { search: { issueCount: 7 } } });
    const importer = createImporter({
      source: "github",
      token: "t",
      baseUrl: `http://ghe.metis.invalid:${t.port}`,
    });
    const n = await importer.count({ owner: "o", repo: "r", state: "open" } as never);
    expect(n).toBe(7);
    expect(t.hits[0]?.url).toBe("/api/graphql");
  });
});

describe("proxy dispatchers reach a real server through the built-in fetch", () => {
  it("connectors: resolveConnectorDispatcher through HTTPS_PROXY", async () => {
    const t = await target();
    const p = await forwardProxy(t.port);
    process.env.HTTPS_PROXY = p.url;
    const d = await resolveConnectorDispatcher(pinnedLoopback("127.0.0.1"));
    const res = await globalThis.fetch(`http://127.0.0.1:${t.port}/`, { dispatcher: d } as Init);
    expect(res.status).toBe(200);
    expect(p.seen).toEqual([`GET http://127.0.0.1:${t.port}/`]);
    await d.close?.();
  });

  it("RAG embedder: createProxyFetch's default ProxyAgent", async () => {
    const t = await target({ embedded: true });
    const p = await forwardProxy(t.port);
    const f = createProxyFetch({ env: { HTTP_PROXY: p.url } });
    const res = await f(`http://127.0.0.1:${t.port}/embed`, { method: "GET" });
    expect(await res.json()).toEqual({ embedded: true });
    expect(p.seen).toEqual([`GET http://127.0.0.1:${t.port}/embed`]);
  });

  it("web research: proxyFetch's ProxyAgent", async () => {
    const t = await target({ searched: true });
    const p = await forwardProxy(t.port);
    process.env.HTTP_PROXY = p.url;
    const res = await proxyFetch(`http://127.0.0.1:${t.port}/search`);
    expect(await res.json()).toEqual({ searched: true });
    expect(p.seen).toEqual([`GET http://127.0.0.1:${t.port}/search`]);
  });
});
