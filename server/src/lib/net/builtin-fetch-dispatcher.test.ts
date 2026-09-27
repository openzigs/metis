/**
 * #308: undici 8 dispatchers driven by Node's BUILT-IN `fetch`, over real
 * loopback sockets.
 *
 * Every test here uses `globalThis.fetch` itself, never a stub, so the Node
 * bundled undici's legacy handler really does meet the undici 8 dispatcher.
 * That meeting is what broke on the Dependabot bump (#10).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "undici";
import { afterEach, describe, expect, it } from "vitest";
import { makePinnedLookup } from "../connectors/network-allowlist.js";
import {
  BuiltinFetchDispatcher,
  agentForBuiltinFetch,
  pinnedAgentForBuiltinFetch,
  proxyAgentForBuiltinFetch,
} from "./builtin-fetch-dispatcher.js";

type Init = RequestInit & { dispatcher?: unknown };

const servers: http.Server[] = [];
const dispatchers: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const d of dispatchers.splice(0)) await d.close().catch(() => undefined);
});

async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

function track<T extends { close(): Promise<void> }>(d: T): T {
  dispatchers.push(d);
  return d;
}

/** The undici error code a built-in `fetch` failure carries on `.cause`. */
function causeCode(err: unknown): string | undefined {
  return ((err as { cause?: { code?: string } }).cause ?? {}).code;
}

const nodeBundledUndiciMajor = Number(process.versions.undici?.split(".")[0] ?? 0);

describe("why the wrapper exists", () => {
  it.skipIf(nodeBundledUndiciMajor >= 8)(
    "a bare undici 8 Agent is rejected by Node's built-in fetch (the #10 failure)",
    async () => {
      const { port } = await listen((_req, res) => res.end("unreachable"));
      const bare = track(new Agent());
      const err = await globalThis
        .fetch(`http://127.0.0.1:${port}/`, { dispatcher: bare } as Init)
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(causeCode(err)).toBe("UND_ERR_INVALID_ARG");
    },
  );
});

describe("a wrapped dispatcher, driven by the built-in fetch over loopback", () => {
  it("completes a request and keeps the inner dispatcher reachable", async () => {
    const { port } = await listen((_req, res) => res.end("hello"));
    const d = track(agentForBuiltinFetch());
    expect(d).toBeInstanceOf(BuiltinFetchDispatcher);
    expect(d.inner).toBeInstanceOf(Agent);
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/`, { dispatcher: d } as Init);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello");
  });

  it("connects to the PINNED address, not whatever the hostname resolves to", async () => {
    let host: string | undefined;
    const { port } = await listen((req, res) => {
      host = req.headers.host;
      res.end("pinned");
    });
    // `.invalid` can never resolve (RFC 2606), so a 200 proves the pinned
    // lookup was used and the Host header still carries the original name.
    const d = track(pinnedAgentForBuiltinFetch(makePinnedLookup("127.0.0.1", 4)!));
    const res = await globalThis.fetch(`http://pinned.metis.invalid:${port}/`, {
      dispatcher: d,
    } as Init);
    expect(await res.text()).toBe("pinned");
    expect(host).toBe(`pinned.metis.invalid:${port}`);
  });

  it("honours headersTimeout: a server that never sends headers fails with UND_ERR_HEADERS_TIMEOUT", async () => {
    const { port } = await listen((req) => {
      req.resume(); // …and never answer.
    });
    const d = track(agentForBuiltinFetch({ headersTimeout: 150 }));
    const started = Date.now();
    const err = await globalThis.fetch(`http://127.0.0.1:${port}/`, { dispatcher: d } as Init).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(causeCode(err)).toBe("UND_ERR_HEADERS_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("honours bodyTimeout: a body that stalls mid-read fails with UND_ERR_BODY_TIMEOUT", async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      // …and the rest never arrives.
    });
    const d = track(agentForBuiltinFetch({ bodyTimeout: 150 }));
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/`, { dispatcher: d } as Init);
    expect(res.status).toBe(200);
    const err = await res.text().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(causeCode(err)).toBe("UND_ERR_BODY_TIMEOUT");
  });

  it("control arm: without a short bodyTimeout the same pause completes", async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("a");
      setTimeout(() => res.end("b"), 400);
    });
    // Control arm: the same pause under a 150 ms body timeout fails (above).
    const d = track(agentForBuiltinFetch({ bodyTimeout: 0 }));
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/`, { dispatcher: d } as Init);
    expect(await res.text()).toBe("ab");
  });

  it("streams: the first chunk reaches the reader before the server writes the second", async () => {
    let sendSecond: () => void = () => undefined;
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      sendSecond = () => res.end("data: two\n\n");
    });
    const d = track(agentForBuiltinFetch({ bodyTimeout: 0 }));
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/`, { dispatcher: d } as Init);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe("data: one\n\n");
    // Only now does the server send the rest, so the first read cannot have
    // come from a buffered whole body.
    sendSecond();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value);
    }
    expect(rest).toBe("data: two\n\n");
  });

  it("aborts: a caller abort mid-body rejects the read and closes the server's socket", async () => {
    let socketClosed!: Promise<void>;
    const { port } = await listen((req, res) => {
      socketClosed = new Promise<void>((r) => req.socket.once("close", () => r()));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
    });
    const d = track(agentForBuiltinFetch({ bodyTimeout: 0 }));
    const ac = new AbortController();
    const res = await globalThis.fetch(`http://127.0.0.1:${port}/`, {
      dispatcher: d,
      signal: ac.signal,
    } as Init);
    const reader = res.body!.getReader();
    await reader.read();
    const pending = reader.read();
    ac.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await socketClosed;
  });

  it("routes through a ProxyAgent to the target", async () => {
    const { port: targetPort } = await listen((_req, res) => res.end("via proxy"));
    const seen: string[] = [];
    // A forward proxy that serves ONE destination: it records the absolute-form
    // request line undici sends for an http:// target and relays it to the
    // fixed test target. Anything else is refused.
    const proxy = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url !== `http://127.0.0.1:${targetPort}/x`) {
        res.writeHead(403).end();
        return;
      }
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: targetPort,
          path: "/x",
          method: req.method,
          headers: req.headers,
        },
        (u) => {
          res.writeHead(u.statusCode ?? 502, u.headers);
          u.pipe(res);
        },
      );
      req.pipe(upstream);
    });
    servers.push(proxy);
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    const d = track(proxyAgentForBuiltinFetch(proxyUrl));
    const res = await globalThis.fetch(`http://127.0.0.1:${targetPort}/x`, {
      dispatcher: d,
    } as Init);
    expect(await res.text()).toBe("via proxy");
    expect(seen).toEqual([`GET http://127.0.0.1:${targetPort}/x`]);
  });
});

describe("no server file builds an undici dispatcher outside this module", () => {
  // A new `new Agent(...)` handed to the built-in fetch would fail only at
  // runtime: the suites that cover those call sites inject fake dispatchers.
  const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const HELPER = path.join("lib", "net", "builtin-fetch-dispatcher.ts");
  const CTOR =
    /new\s+(?:undici\.)?(?:Agent|ProxyAgent|EnvHttpProxyAgent|RetryAgent|Socks5ProxyAgent|Pool|BalancedPool|RoundRobinPool|Client|H2CClient)\s*\(/;

  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });
  }

  it("finds the helper itself (the scan is not vacuous)", () => {
    const helper = readFileSync(path.join(srcRoot, HELPER), "utf8");
    expect(helper).toMatch(CTOR);
  });

  it("every other undici-importing file constructs no dispatcher of its own", () => {
    const offenders = walk(srcRoot)
      .filter((f) => path.relative(srcRoot, f) !== HELPER)
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return /["']undici["']/.test(text) && CTOR.test(text);
      })
      .map((f) => path.relative(srcRoot, f));
    expect(offenders).toEqual([]);
  });
});
