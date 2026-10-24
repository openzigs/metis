/**
 * #1471 — the REAL publish Octokit (no `__setPublishOctokitFactory`) sends
 * every request through `buildPublishFetch`: the pinned address is the one
 * connected to, a redirect is refused rather than followed, and a hung
 * request is aborted at the deadline.
 *
 * `@octokit/request` ≥10 ignored the `request.agent` / `request.timeout` this
 * factory used to set, so before #1471 a pinned `.invalid` host failed with
 * `getaddrinfo ENOTFOUND` (system DNS), a 302 was followed, and a hang hung.
 */
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  __resetPublishOctokitCache,
  acquirePublishOctokit,
} from "../src/lib/publishing/octokit-factory.js";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let handler: Handler = (_req, res) => res.end("{}");
const seen: IncomingMessage[] = [];
let other: http.Server;
let otherHits = 0;
let server: http.Server;
let port = 0;
let otherPort = 0;
const saved: Record<string, string | undefined> = {};
const PROXY_ENV = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

beforeAll(async () => {
  for (const k of PROXY_ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  server = http.createServer((req, res) => {
    seen.push(req);
    handler(req, res);
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

  it("refuses a redirect instead of following it", async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/elsewhere` });
      res.end();
    };
    const gh = await client("t-redirect");
    await expect(gh.request({ method: "GET", url: "/repos/acme/site" })).rejects.toBeTruthy();
    expect(seen).toHaveLength(1);
    expect(otherHits).toBe(0);
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
