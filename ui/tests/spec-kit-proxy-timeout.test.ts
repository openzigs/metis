// @vitest-environment node
/**
 * #1069 — which proxy requests get the long upstream timeout, how long it is,
 * and (against a real socket) that it is actually applied.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  SPEC_KIT_PROXY_TIMEOUT_DEFAULT_MS,
  SPEC_KIT_PROXY_TIMEOUT_MAX_MS,
  SPEC_KIT_PROXY_TIMEOUT_MIN_MS,
  createLongTimeoutFetch,
  SPEC_KIT_PROXY_MAX_CONNECTIONS,
  isSpecKitCommandRequest,
  resolveSpecKitProxyTimeoutMs,
} from "@/lib/spec-kit-proxy-timeout";
import { pathBelowUpstreamBase } from "@/lib/proxy-upstream";

// The matcher is handed the RESOLVED upstream path below the base, as the route
// does: what `new URL` made of the segments, not the segments themselves.
const BASE = "http://localhost:4000/api";
const resolved = (...segments: string[]): string =>
  pathBelowUpstreamBase(new URL(`${BASE}/${segments.join("/")}`), BASE) ?? "<outside the base>";

describe("isSpecKitCommandRequest", () => {
  it("matches POST /projects/:id/spec-kit/commands/:cmd", () => {
    for (const cmd of ["speckit.plan", "speckit.specify", "plan", "speckit plan"]) {
      expect(
        isSpecKitCommandRequest("POST", resolved("projects", "p1", "spec-kit", "commands", cmd)),
      ).toBe(true);
    }
    expect(isSpecKitCommandRequest("post", "projects/p1/spec-kit/commands/x")).toBe(true);
  });

  it.each([
    ["another method", "GET", "projects/p1/spec-kit/commands/speckit.plan"],
    ["the artifact list", "GET", "projects/p1/spec-kit/files"],
    ["an artifact write", "PUT", "projects/p1/spec-kit/files/spec.md"],
    ["the constitution route", "POST", "projects/p1/spec-kit/constitution"],
    ["a feature route", "POST", "projects/p1/spec-kit/features/f1/archive"],
    ["no command", "POST", "projects/p1/spec-kit/commands"],
    ["an empty command", "POST", "projects/p1/spec-kit/commands/"],
    ["an empty project", "POST", "projects//spec-kit/commands/speckit.plan"],
    ["a longer path", "POST", "projects/p1/spec-kit/commands/speckit.plan/x"],
    ["a trailing slash", "POST", "projects/p1/spec-kit/commands/speckit.plan/"],
    ["a leading slash", "POST", "/projects/p1/spec-kit/commands/speckit.plan"],
    ["another resource", "POST", "workspaces/p1/spec-kit/commands/speckit.plan"],
    ["another project route", "POST", "projects/p1/analysis/commands/speckit.plan"],
    ["a lookalike", "POST", "projects/p1/spec-kit/command/speckit.plan"],
    ["a dot-segment command", "POST", "projects/p1/spec-kit/commands/.."],
    ["an encoded dot-segment command", "POST", "projects/p1/spec-kit/commands/%2E%2e"],
    ["a dot-segment project", "POST", "projects/./spec-kit/commands/speckit.plan"],
    ["chat", "POST", "chat/stream"],
    ["the root", "POST", ""],
  ])("does not match %s", (_name, method, path) => {
    expect(isSpecKitCommandRequest(method, path)).toBe(false);
  });

  // One decoded segment holding `/`, `\` or `?`: five raw segments that spell
  // a command, resolving to some other route. None may get the long timeout.
  it.each([
    ["../../../../chat/stream", "chat/stream"],
    ["x/../../constitution", "projects/p1/spec-kit/constitution"],
    ["..\\..\\constitution", "projects/p1/constitution"],
    ["../../../../../health", "<outside the base>"],
  ])("does not match a command segment of %j, which resolves to %s", (segment, route) => {
    const path = resolved("projects", "p1", "spec-kit", "commands", segment);
    expect(path).toBe(route);
    expect(isSpecKitCommandRequest("POST", path)).toBe(false);
  });

  it("does not match a traversing project id", () => {
    const path = resolved("projects", "x/../../chat", "spec-kit", "commands", "x");
    expect(path).toBe("chat/spec-kit/commands/x");
    expect(isSpecKitCommandRequest("POST", path)).toBe(false);
  });
});

describe("resolveSpecKitProxyTimeoutMs", () => {
  it("defaults to 15 minutes", () => {
    expect(SPEC_KIT_PROXY_TIMEOUT_DEFAULT_MS).toBe(900_000);
    expect(resolveSpecKitProxyTimeoutMs(undefined)).toBe(900_000);
    expect(resolveSpecKitProxyTimeoutMs("")).toBe(900_000);
  });

  it("takes a whole number of milliseconds", () => {
    expect(resolveSpecKitProxyTimeoutMs("600000")).toBe(600_000);
    expect(resolveSpecKitProxyTimeoutMs(" 1200000 ")).toBe(1_200_000);
  });

  it("is bounded: never below fetch's own default, never above an hour", () => {
    expect(SPEC_KIT_PROXY_TIMEOUT_MIN_MS).toBe(300_000);
    expect(SPEC_KIT_PROXY_TIMEOUT_MAX_MS).toBe(3_600_000);
    expect(resolveSpecKitProxyTimeoutMs("0")).toBe(300_000);
    expect(resolveSpecKitProxyTimeoutMs("1000")).toBe(300_000);
    expect(resolveSpecKitProxyTimeoutMs("999999999999")).toBe(3_600_000);
  });

  it.each(["abc", "-5", "1e9", "15m", "900000.5", "Infinity"])(
    "falls back to the default for %s",
    (raw) => {
      expect(resolveSpecKitProxyTimeoutMs(raw)).toBe(900_000);
    },
  );
});

describe("createLongTimeoutFetch — against a real socket", () => {
  let server: http.Server | undefined;

  const listen = async (handler: http.RequestListener): Promise<URL> => {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  };
  const until = async (condition: () => boolean): Promise<void> => {
    while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
  };

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => (server ? server.close(resolve) : resolve(undefined)));
    server = undefined;
  });

  // Node's global fetch rejects a dispatcher from another undici version with
  // UND_ERR_INVALID_ARG before sending anything, so a response at all proves
  // the dispatcher and the fetch are a matching pair.
  it("sends the method, headers and a streamed body, and returns the response", async () => {
    const url = await listen((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => (body += chunk.toString()));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.statusCode = 201;
        res.end(JSON.stringify({ method: req.method, auth: req.headers.authorization, body }));
      });
    });
    const longFetch = createLongTimeoutFetch(60_000);
    const res = await longFetch(url, {
      method: "POST",
      headers: new Headers({ Authorization: "Bearer t" }),
      body: new Blob(['{"input":"go"}']).stream(),
      duplex: "half",
      signal: new AbortController().signal,
    });
    expect(res.status).toBe(201);
    expect(await new Response(res.body).json()).toEqual({
      method: "POST",
      auth: "Bearer t",
      body: '{"input":"go"}',
    });
  });

  // The upstream never answers, so the only way out is the agent's own
  // headersTimeout: without the dispatcher this would wait 300 s.
  it("gives up after the configured headers timeout", async () => {
    const url = await listen(() => {
      /* never respond */
    });
    const longFetch = createLongTimeoutFetch(200);
    const outcome = await longFetch(url, { method: "POST", body: "x" }).then(
      () => "responded",
      (err: { cause?: { code?: string } }) => err.cause?.code,
    );
    expect(outcome).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  // What the route does with `req.signal`: Node's own AbortSignal, handed to
  // undici's fetch. The upstream sees its socket close, not a 15-minute wait.
  it("aborts the upstream request when the caller's signal aborts", async () => {
    let received = false;
    let closed = false;
    const url = await listen((req) => {
      received = true;
      req.socket.on("close", () => (closed = true));
      /* never respond */
    });
    const client = new AbortController();
    const outcome = createLongTimeoutFetch(60_000)(url, {
      method: "POST",
      body: "x",
      signal: client.signal,
    }).then(
      () => "responded",
      (err: { name?: string }) => err.name,
    );
    await until(() => received);
    expect(closed).toBe(false);

    client.abort();

    expect(await outcome).toBe("AbortError");
    await until(() => closed);
  });

  // Held requests never share a socket, so the sockets the upstream sees are
  // the agent's connections: the cap, with the rest queued behind it.
  it("holds at most the connection cap, and queues the rest", async () => {
    expect(SPEC_KIT_PROXY_MAX_CONNECTIONS).toBe(16);
    const held: http.ServerResponse[] = [];
    const url = await listen((_req, res) => {
      held.push(res);
    });
    const longFetch = createLongTimeoutFetch(60_000);
    const total = SPEC_KIT_PROXY_MAX_CONNECTIONS + 4;
    const all = Array.from({ length: total }, () =>
      longFetch(url, { method: "POST", body: "x" }).then((res) => res.status),
    );

    await until(() => held.length >= SPEC_KIT_PROXY_MAX_CONNECTIONS);
    // Long enough for an uncapped agent to have opened the other four.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(held).toHaveLength(SPEC_KIT_PROXY_MAX_CONNECTIONS);

    // Answering frees the sockets, and the queued requests then go out.
    let answered = 0;
    while (answered < total) {
      await until(() => held.length > answered);
      held[answered]!.end("ok");
      answered += 1;
    }
    expect(await Promise.all(all)).toEqual(Array.from({ length: total }, () => 200));
  });
});
