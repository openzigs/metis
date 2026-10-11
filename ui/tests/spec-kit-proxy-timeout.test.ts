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
  isSpecKitCommandRequest,
  resolveSpecKitProxyTimeoutMs,
} from "@/lib/spec-kit-proxy-timeout";

describe("isSpecKitCommandRequest", () => {
  it("matches POST /projects/:id/spec-kit/commands/:cmd", () => {
    for (const cmd of ["speckit.plan", "speckit.specify", "plan"]) {
      expect(isSpecKitCommandRequest("POST", ["projects", "p1", "spec-kit", "commands", cmd])).toBe(
        true,
      );
    }
    expect(isSpecKitCommandRequest("post", ["projects", "p1", "spec-kit", "commands", "x"])).toBe(
      true,
    );
  });

  it.each([
    ["another method", "GET", ["projects", "p1", "spec-kit", "commands", "speckit.plan"]],
    ["the artifact list", "GET", ["projects", "p1", "spec-kit", "files"]],
    ["an artifact write", "PUT", ["projects", "p1", "spec-kit", "files", "spec.md"]],
    ["the constitution route", "POST", ["projects", "p1", "spec-kit", "constitution"]],
    ["a feature route", "POST", ["projects", "p1", "spec-kit", "features", "f1", "archive"]],
    ["no command", "POST", ["projects", "p1", "spec-kit", "commands"]],
    ["an empty command", "POST", ["projects", "p1", "spec-kit", "commands", ""]],
    ["an empty project", "POST", ["projects", "", "spec-kit", "commands", "speckit.plan"]],
    ["a longer path", "POST", ["projects", "p1", "spec-kit", "commands", "speckit.plan", "x"]],
    ["another resource", "POST", ["workspaces", "p1", "spec-kit", "commands", "speckit.plan"]],
    ["another project route", "POST", ["projects", "p1", "analysis", "commands", "speckit.plan"]],
    ["a lookalike", "POST", ["projects", "p1", "spec-kit", "command", "speckit.plan"]],
    ["chat", "POST", ["chat", "stream"]],
    ["the root", "POST", []],
  ])("does not match %s", (_name, method, path) => {
    expect(isSpecKitCommandRequest(method, path)).toBe(false);
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

  const listen = async (handler: http.RequestListener): Promise<string> => {
    server = http.createServer(handler);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
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
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      headers: new Headers({ Authorization: "Bearer t" }),
      body: new Blob(['{"input":"go"}']).stream(),
      duplex: "half",
    };
    const res = await longFetch(url, init);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ method: "POST", auth: "Bearer t", body: '{"input":"go"}' });
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
});
