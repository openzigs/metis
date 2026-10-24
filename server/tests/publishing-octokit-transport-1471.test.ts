/**
 * #1471 — the REAL publish Octokit (no `__setPublishOctokitFactory`) sends
 * every request through `buildPublishFetch`: the pinned address is the one
 * connected to, a redirect is followed only on the same origin (scheme, host
 * and port; at most five) and any other is refused, and a hung request is
 * aborted at the deadline.
 *
 * `@octokit/request` ≥10 ignored the `request.agent` / `request.timeout` this
 * factory used to set, so before #1471 a pinned `.invalid` host failed with
 * `getaddrinfo ENOTFOUND` (system DNS), a 302 was followed, and a hang hung.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __resetPublishOctokitCache,
  acquirePublishOctokit,
} from "../src/lib/publishing/octokit-factory.js";
import { PublishError } from "../src/lib/publishing/types.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Handler = (_req, res) => res.end("{}");
const seen: IncomingMessage[] = [];
/** The body each request to `server` carried, in order. */
const bodies: string[] = [];
let other: http.Server;
let otherHits = 0;
let server: http.Server;
let port = 0;
let otherPort = 0;
const saved: Record<string, string | undefined> = {};
const PROXY_ENV = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
];

beforeAll(async () => {
  for (const k of PROXY_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  server = http.createServer((req, res) => {
    seen.push(req);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      handler(req, res);
    });
  });
  other = http.createServer((_req, res) => {
    otherHits += 1;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => other.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  otherPort = (other.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  other.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => other.close(() => r()));
  for (const k of PROXY_ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

afterEach(() => {
  seen.length = 0;
  bodies.length = 0;
  otherHits = 0;
  handler = (_req, res) => res.end("{}");
  __resetPublishOctokitCache();
});

/** A host that no resolver can answer: reaching the server proves the pin was used. */
const client = (token: string, timeoutMs?: number) =>
  acquirePublishOctokit({
    owner: "acme",
    baseUrl: `http://pin-probe-1471.invalid:${port}`,
    token,
    pinnedAddress: "127.0.0.1",
    pinnedFamily: 4,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });

describe("#1471 — the real publish client's transport", () => {
  it("connects to the pinned address, never resolving the hostname", async () => {
    handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ full_name: "acme/site" }));
    };
    const gh = await client("t-pin");
    const res = await gh.request<{ full_name: string }>({
      method: "GET",
      url: "/repos/acme/site",
    });
    expect(res.data.full_name).toBe("acme/site");
    expect(seen).toHaveLength(1);
    // The Host header (and TLS SNI) stays the hostname; only the socket is pinned.
    expect(seen[0].headers.host).toBe(`pin-probe-1471.invalid:${port}`);
    expect(seen[0].headers.authorization).toBe("token t-pin");
    expect(seen[0].headers["x-github-api-version"]).toBeTruthy();
  });

  it("refuses a redirect to another host instead of following it", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/elsewhere` });
      res.end();
    };
    const gh = await client("t-redirect");
    await expect(gh.request({ method: "GET", url: "/repos/acme/site" })).rejects.toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(otherHits).toBe(0);
  });

  it("follows a same-host redirect (a renamed or transferred repository), still pinned", async () => {
    handler = (req, res) => {
      if (req.url === "/repos/acme/old-name") {
        res.writeHead(301, { location: "/repos/acme/new-name" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ full_name: "acme/new-name" }));
    };
    const gh = await client("t-moved");
    const res = await gh.request<{ full_name: string }>({
      method: "GET",
      url: "/repos/acme/old-name",
    });
    expect(res.data.full_name).toBe("acme/new-name");
    expect(seen.map((r) => r.url)).toEqual(["/repos/acme/old-name", "/repos/acme/new-name"]);
    expect(seen[1].headers.authorization).toBe("token t-moved");
  });

  it("gives up after too many same-host redirects", async () => {
    handler = (_req, res) => {
      res.writeHead(307, { location: "/repos/acme/loop" });
      res.end();
    };
    const gh = await client("t-loop");
    await expect(gh.request({ method: "GET", url: "/repos/acme/loop" })).rejects.toBeTruthy();
    expect(seen.length).toBeLessThanOrEqual(6);
  });
  /** The typed, non-retryable refusal (#1478) — never an Octokit 500. */
  async function refusal(p: Promise<unknown>): Promise<PublishError> {
    const err = await p.then(
      () => {
        throw new Error("expected the request to be refused");
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PublishError);
    const pe = err as PublishError;
    expect(pe.retryable).toBe(false);
    expect(pe.name).toBe("PublishError");
    return pe;
  }

  it("#1478 — a refused redirect is a typed, non-retryable PublishError, not an Octokit 500", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/elsewhere` });
      res.end();
    };
    const gh = await client("t-typed");
    const err = await refusal(gh.request({ method: "GET", url: "/repos/acme/site" }));
    expect(err.code).toBe("GITHUB_REDIRECT_REFUSED");
    expect(err.status).toBe(502);
    expect(err.message).not.toContain("t-typed");
    expect(otherHits).toBe(0);
  });

  it.each([500, 503])(
    "#1486 — a real GitHub %i still reaches callers as Octokit's RequestError with its status",
    async (status) => {
      handler = (_req, res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "Server Error" }));
      };
      const gh = await client(`t-5xx-${status}`);
      const err = (await gh.request({ method: "GET", url: "/repos/acme/site" }).then(
        () => {
          throw new Error("expected the request to fail");
        },
        (e: unknown) => e,
      )) as { name?: string; status?: number; response?: { status?: number } };
      // Only a refusal from `buildPublishFetch` is unwrapped; GitHub's own
      // error answer is passed through untouched, so status classifiers work.
      expect(err).not.toBeInstanceOf(PublishError);
      expect(err.name).toBe("HttpError");
      expect(err.status).toBe(status);
      expect(err.response?.status).toBe(status);
      expect(seen).toHaveLength(1);
    },
  );

  it("#1478 — refuses a redirect to the same host on another port", async () => {
    // Same hostname, so a hostname-only check would follow it — through the
    // pin, to the other server's port.
    handler = (_req, res) => {
      res.writeHead(301, {
        location: `http://pin-probe-1471.invalid:${otherPort}/repos/acme/site`,
      });
      res.end();
    };
    const gh = await client("t-port");
    const err = await refusal(gh.request({ method: "GET", url: "/repos/acme/site" }));
    expect(err.code).toBe("GITHUB_REDIRECT_REFUSED");
    expect(seen).toHaveLength(1);
    expect(otherHits).toBe(0);
  });

  it("#1478 — refuses a redirect to the same host and port under another scheme", async () => {
    // A hostname-only check would attempt TLS to this plain-HTTP server and
    // fail some other way; only an origin check refuses it as a redirect.
    handler = (_req, res) => {
      res.writeHead(307, {
        location: `https://pin-probe-1471.invalid:${port}/repos/acme/site`,
      });
      res.end();
    };
    const gh = await client("t-scheme");
    const err = await refusal(gh.request({ method: "GET", url: "/repos/acme/site" }));
    expect(err.code).toBe("GITHUB_REDIRECT_REFUSED");
    expect(seen).toHaveLength(1);
  });

  it("#1478 — too many same-origin redirects is a typed, non-retryable PublishError", async () => {
    handler = (_req, res) => {
      res.writeHead(307, { location: "/repos/acme/loop" });
      res.end();
    };
    const gh = await client("t-loop-typed");
    const err = await refusal(gh.request({ method: "GET", url: "/repos/acme/loop" }));
    expect(err.code).toBe("GITHUB_TOO_MANY_REDIRECTS");
    // The first request plus five followed redirects.
    expect(seen).toHaveLength(6);
  });

  it.each([303, 302, 301])(
    "#1478 — a %i answering a POST is followed as a GET, without the body or its content type",
    async (status) => {
      handler = (req, res) => {
        if (req.url === "/repos/acme/site/issues") {
          res.writeHead(status, { location: "/repos/acme/site/issues/7" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ number: 7 }));
      };
      const gh = await client(`t-post-${status}`);
      const res = await gh.request<{ number: number }>({
        method: "POST",
        url: "/repos/acme/site/issues",
        data: { title: "a" },
      });
      expect(res.data.number).toBe(7);
      expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
        "POST /repos/acme/site/issues",
        "GET /repos/acme/site/issues/7",
      ]);
      expect(seen[0].headers["content-type"]).toMatch(/application\/json/);
      expect(bodies[0]).toBe(JSON.stringify({ title: "a" }));
      expect(seen[1].headers["content-type"]).toBeUndefined();
      expect(seen[1].headers["content-length"]).toBeUndefined();
      expect(seen[1].headers["transfer-encoding"]).toBeUndefined();
      expect(bodies[1]).toBe("");
      expect(seen[1].headers.authorization).toBe(`token t-post-${status}`);
    },
  );

  it("#1478 — a 307 answering a POST repeats the POST with its body", async () => {
    handler = (req, res) => {
      if (req.url === "/repos/acme/old/issues") {
        res.writeHead(307, { location: "/repos/acme/new/issues" });
        res.end();
        return;
      }
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ number: 8 }));
    };
    const gh = await client("t-post-307");
    const res = await gh.request<{ number: number }>({
      method: "POST",
      url: "/repos/acme/old/issues",
      data: { title: "b" },
    });
    expect(res.data.number).toBe(8);
    expect(seen.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /repos/acme/old/issues",
      "POST /repos/acme/new/issues",
    ]);
    expect(bodies[1]).toBe(JSON.stringify({ title: "b" }));
    expect(seen[1].headers["content-type"]).toMatch(/application\/json/);
  });

  it("sends an unpinned (public) host's requests through the egress proxy", async () => {
    const proxyHits: string[] = [];
    const proxy = http.createServer((req, res) => {
      proxyHits.push(`request ${req.url}`);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ full_name: "via-proxy" }));
    });
    proxy.on("connect", (req, socket) => {
      proxyHits.push(`connect ${req.url}`);
      const upstream = net.connect(port, "127.0.0.1", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      upstream.on("error", () => socket.destroy());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    process.env.HTTPS_PROXY = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    try {
      handler = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ full_name: "via-tunnel" }));
      };
      // No pinned address: the host is never resolved here; only the proxy can reach it.
      const gh = await acquirePublishOctokit({
        owner: "acme",
        baseUrl: `http://unpinned-1471.invalid:${port}`,
        token: "t-proxy",
      });
      const res = await gh.request<{ full_name: string }>({
        method: "GET",
        url: "/repos/acme/site",
      });
      expect(["via-proxy", "via-tunnel"]).toContain(res.data.full_name);
      expect(proxyHits.length).toBeGreaterThanOrEqual(1);
      expect(proxyHits[0]).toContain("unpinned-1471.invalid");
    } finally {
      delete process.env.HTTPS_PROXY;
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });

  it("aborts a request that hangs past the deadline", async () => {
    handler = () => {
      /* never answers */
    };
    const gh = await client("t-hang", 300);
    const started = Date.now();
    await expect(gh.request({ method: "GET", url: "/repos/acme/site" })).rejects.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(seen).toHaveLength(1);
  });
});
