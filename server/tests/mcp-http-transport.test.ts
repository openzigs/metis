/**
 * HTTP transport — URL allow-list, session id capture, request/response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MCPHttpTransport,
  validateUrl,
  assertSafeUrl,
  isPrivateIp,
} from "../src/lib/mcp/http-transport.js";

const ORIG_ENV = { ...process.env };

function restoreEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIG_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIG_ENV);
}

beforeEach(() => {
  delete process.env.MCP_ALLOWED_HOSTS;
  delete process.env.MCP_ALLOW_LOOPBACK;
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  restoreEnv();
});

describe("validateUrl", () => {
  it("rejects malformed URLs", () => {
    expect(() => validateUrl("not a url")).toThrow();
  });
  it("rejects unsupported schemes", () => {
    expect(() => validateUrl("ws://x")).toThrow();
    expect(() => validateUrl("file:///etc/passwd")).toThrow();
  });
  it("requires HTTPS in production for non-loopback hosts", () => {
    process.env.NODE_ENV = "production";
    expect(() => validateUrl("http://api.example.com/mcp")).toThrow(/HTTPS/);
  });
  it("permits HTTPS in production", () => {
    process.env.NODE_ENV = "production";
    expect(() => validateUrl("https://api.example.com/mcp")).not.toThrow();
  });
  it("blocks loopback in production unless MCP_ALLOW_LOOPBACK=1", () => {
    process.env.NODE_ENV = "production";
    expect(() => validateUrl("http://127.0.0.1:8080/mcp")).toThrow(/loopback/);
    process.env.MCP_ALLOW_LOOPBACK = "1";
    expect(() => validateUrl("http://127.0.0.1:8080/mcp")).not.toThrow();
  });
  it("blocks RFC1918 private hosts unless on allow-list", () => {
    expect(() => validateUrl("http://10.0.0.5/mcp")).toThrow(/private/);
    expect(() => validateUrl("http://192.168.1.10/mcp")).toThrow(/private/);
    expect(() => validateUrl("http://172.16.0.5/mcp")).toThrow(/private/);
    expect(() => validateUrl("http://169.254.169.254/")).toThrow(/private/);
    process.env.MCP_ALLOWED_HOSTS = "10.0.0.5";
    expect(() => validateUrl("http://10.0.0.5/mcp")).not.toThrow();
  });
  it("blocks IPv6 ULA / link-local without allow-list", () => {
    expect(() => validateUrl("http://[fc00::1]/")).toThrow(/private/);
    expect(() => validateUrl("http://[fe80::1]/")).toThrow(/private/);
  });
});

describe("MCPHttpTransport", () => {
  const publicLookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
  function makeFetch(responseFn: (req: { url: string; init: RequestInit }) => Response) {
    return vi.fn(async (url: string, init: RequestInit = {}) => responseFn({ url, init }));
  }
  it("captures Mcp-Session-Id from the first response and echoes on subsequent requests", async () => {
    let calls = 0;
    const fetchFn = makeFetch(({ init }) => {
      calls += 1;
      const headers: Record<string, string> = {};
      if (calls === 1) headers["mcp-session-id"] = "sess-123";
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(String(init.body)).id,
          result: { ok: calls },
        }),
        { status: 200, headers },
      );
    });
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchFn: fetchFn as any,
      lookupFn: publicLookup,
    });
    await t.start();
    await t.request("initialize");
    expect(t.currentSessionId).toBe("sess-123");
    await t.request("tools/list");
    const lastInit = (fetchFn.mock.calls[1][1] as RequestInit).headers as Record<string, string>;
    expect(lastInit["Mcp-Session-Id"]).toBe("sess-123");
  });

  it("throws on non-2xx responses", async () => {
    const fetchFn = makeFetch(() => new Response("nope", { status: 500, statusText: "Server" }));
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      lookupFn: publicLookup,
    });
    await t.start();
    await expect(t.request("ping")).rejects.toThrow(/MCP HTTP 500/);
  });

  it("propagates JSON-RPC error fields", async () => {
    const fetchFn = makeFetch(({ init }) => {
      const id = JSON.parse(String(init.body)).id;
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "missing" } }),
        { status: 200 },
      );
    });
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      lookupFn: publicLookup,
    });
    await t.start();
    await expect(t.request("ping")).rejects.toThrow(/missing/);
  });

  it("DELETE on stop when a session was issued", async () => {
    let saw = "";
    const fetchFn = makeFetch(({ init }) => {
      saw = init.method ?? "POST";
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
        status: 200,
        headers: { "mcp-session-id": "abc" },
      });
    });
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      lookupFn: publicLookup,
    });
    await t.start();
    await t.request("initialize");
    await t.stop();
    expect(saw).toBe("DELETE");
  });

  it("rejects work after stop()", async () => {
    const fetchFn = makeFetch(
      () => new Response("{}", { status: 200, headers: { "mcp-session-id": "x" } }),
    );
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      lookupFn: publicLookup,
    });
    await t.start();
    await t.stop();
    await expect(t.request("ping")).rejects.toThrow(/stopped/);
  });
});

describe("isPrivateIp (SEC-1 helper)", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "192.168.5.5",
    "172.20.0.1",
    "169.254.169.254",
    "::1",
    "fe80::1",
    "fc00::1",
    "fd00::1",
    "0.0.0.0",
    "::ffff:127.0.0.1",
    "100.64.0.1",
  ])("flags %s as private", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888"])("allows public %s", (ip) =>
    expect(isPrivateIp(ip)).toBe(false),
  );
});

describe("assertSafeUrl (SEC-1 DNS pinning)", () => {
  it("rejects when DNS resolves a public hostname to loopback (DNS rebinding)", async () => {
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    await expect(assertSafeUrl("https://evil.example.com/", lookup)).rejects.toThrow(
      /resolves to private/,
    );
  });
  it("rejects when DNS resolves to AWS metadata IP", async () => {
    const lookup = vi.fn(async () => [{ address: "169.254.169.254", family: 4 as const }]);
    await expect(assertSafeUrl("https://meta.example.com/", lookup)).rejects.toThrow(
      /resolves to private/,
    );
  });
  it("rejects when ANY resolved address is private (mixed answers)", async () => {
    const lookup = vi.fn(async () => [
      { address: "8.8.8.8", family: 4 as const },
      { address: "10.0.0.5", family: 4 as const },
    ]);
    await expect(assertSafeUrl("https://mixed.example.com/", lookup)).rejects.toThrow(
      /resolves to private/,
    );
  });
  it("permits a public hostname with public DNS", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    await expect(assertSafeUrl("https://api.example.com/mcp", lookup)).resolves.toBeInstanceOf(URL);
  });
  it("permits a hostname on MCP_ALLOWED_HOSTS regardless of resolution", async () => {
    process.env.MCP_ALLOWED_HOSTS = "internal.corp";
    const lookup = vi.fn(async () => [{ address: "10.0.0.5", family: 4 as const }]);
    await expect(assertSafeUrl("https://internal.corp/mcp", lookup)).resolves.toBeInstanceOf(URL);
  });
  it("rejects unsupported scheme synchronously", async () => {
    await expect(assertSafeUrl("file:///etc/passwd", async () => [])).rejects.toThrow();
  });
  it("rejects when DNS lookup returns nothing", async () => {
    const lookup = vi.fn(async () => []);
    await expect(assertSafeUrl("https://nx.example.com/", lookup)).rejects.toThrow(/no addresses/);
  });
  it("rejects when DNS lookup throws", async () => {
    const lookup = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });
    await expect(assertSafeUrl("https://nx.example.com/", lookup)).rejects.toThrow(
      /DNS lookup failed/,
    );
  });
  it("rejects IP literals in private space", async () => {
    await expect(assertSafeUrl("http://10.0.0.5/mcp", async () => [])).rejects.toThrow(/private/);
  });
  it("permits loopback host when MCP_ALLOW_LOOPBACK=1", async () => {
    process.env.MCP_ALLOW_LOOPBACK = "1";
    await expect(
      assertSafeUrl("http://127.0.0.1:9000/mcp", async () => []),
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("MCPHttpTransport SSRF redirect guard (SEC-2)", () => {
  function makeFetch(responseFn: (req: { url: string; init: RequestInit }) => Response) {
    return vi.fn(async (url: string, init: RequestInit = {}) => responseFn({ url, init }));
  }

  it("sends redirect: 'manual' on every request", async () => {
    const fetchFn = makeFetch(
      ({ init }) =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: {} }),
          {
            status: 200,
          },
        ),
    );
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      lookupFn: lookup,
    });
    await t.start();
    await t.request("ping");
    const init = fetchFn.mock.calls[0][1] as RequestInit;
    expect(init.redirect).toBe("manual");
  });

  it("re-validates Location header on 302 (rejects redirect to metadata service)", async () => {
    let calls = 0;
    const lookup = vi.fn(async (host: string) => {
      if (host === "api.example.com") return [{ address: "8.8.8.8", family: 4 as const }];
      // Attacker-controlled redirect target
      return [{ address: "169.254.169.254", family: 4 as const }];
    });
    const fetchFn = makeFetch(({ url }) => {
      calls += 1;
      if (calls === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "https://attacker.example.com/aws/" },
        });
      }
      // The transport should never reach the second fetch
      throw new Error(`unexpected second fetch to ${url}`);
    });
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      lookupFn: lookup,
    });
    await t.start();
    await expect(t.request("ping")).rejects.toThrow(/resolves to private/);
    expect(calls).toBe(1);
  });

  it("follows safe redirects up to MAX_REDIRECT_HOPS", async () => {
    let calls = 0;
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const fetchFn = makeFetch(({ init }) => {
      calls += 1;
      if (calls === 1) {
        return new Response("", {
          status: 302,
          headers: { location: "https://api2.example.com/mcp" },
        });
      }
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: JSON.parse(String(init.body)).id,
          result: { ok: true },
        }),
        { status: 200 },
      );
    });
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      lookupFn: lookup,
    });
    await t.start();
    await expect(t.request("ping")).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("aborts on too many redirect hops", async () => {
    const lookup = vi.fn(async () => [{ address: "8.8.8.8", family: 4 as const }]);
    const fetchFn = makeFetch(
      () =>
        new Response("", {
          status: 302,
          headers: { location: "https://api.example.com/mcp" },
        }),
    );
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      lookupFn: lookup,
    });
    await t.start();
    await expect(t.request("ping")).rejects.toThrow(/redirect hop limit/);
  });

  it("skipHostCheck bypass still applies during redirect (escape hatch for tests only)", async () => {
    let calls = 0;
    const fetchFn = makeFetch(({ init }) => {
      calls += 1;
      if (calls === 1)
        return new Response("", { status: 302, headers: { location: "https://other/" } });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: JSON.parse(String(init.body)).id, result: 1 }),
        { status: 200 },
      );
    });
    const t = new MCPHttpTransport({
      url: "https://api.example.com/mcp",
      fetchFn: fetchFn as never,
      skipHostCheck: true,
    });
    await t.start();
    await expect(t.request("ping")).resolves.toEqual(1);
  });
});
