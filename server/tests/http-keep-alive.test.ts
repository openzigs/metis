/**
 * #221 — `HTTP_KEEP_ALIVE_TIMEOUT_MS` reaches the HTTP server.
 *
 * The e2e stack sets it to `0` because Playwright's API request pool never
 * expires an idle socket, so any server-side idle close can land on a socket
 * the pool is about to reuse (`socket hang up`). These tests pin the parsing,
 * that the value reaches a real server (read back over HTTP, the way a client
 * sees it), and that `createServer()` applies it.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyHttpKeepAliveTimeout,
  HTTP_KEEP_ALIVE_TIMEOUT_ENV,
} from "../src/lib/config/http-keep-alive.js";

const NODE_DEFAULT_MS = http.createServer().keepAliveTimeout;

describe("applyHttpKeepAliveTimeout (#221)", () => {
  it("keeps Node's default when the setting is unset or blank", () => {
    for (const env of [
      {},
      { [HTTP_KEEP_ALIVE_TIMEOUT_ENV]: "" },
      { [HTTP_KEEP_ALIVE_TIMEOUT_ENV]: "  " },
    ]) {
      const server = http.createServer();
      expect(applyHttpKeepAliveTimeout(server, env)).toBe(NODE_DEFAULT_MS);
      expect(server.keepAliveTimeout).toBe(NODE_DEFAULT_MS);
    }
  });

  it.each([
    ["0", 0],
    ["65000", 65_000],
    [" 120000 ", 120_000],
  ])("applies %j as %i ms", (raw, expected) => {
    const server = http.createServer();
    expect(applyHttpKeepAliveTimeout(server, { [HTTP_KEEP_ALIVE_TIMEOUT_ENV]: raw })).toBe(
      expected,
    );
    expect(server.keepAliveTimeout).toBe(expected);
  });

  it.each(["-1", "5s", "1.5e3", "abc", "99999999999"])(
    "keeps Node's default for the invalid value %j",
    (raw) => {
      const server = http.createServer();
      expect(applyHttpKeepAliveTimeout(server, { [HTTP_KEEP_ALIVE_TIMEOUT_ENV]: raw })).toBe(
        NODE_DEFAULT_MS,
      );
    },
  );

  it("reads process.env when no env is passed", () => {
    const before = process.env[HTTP_KEEP_ALIVE_TIMEOUT_ENV];
    process.env[HTTP_KEEP_ALIVE_TIMEOUT_ENV] = "0";
    try {
      expect(applyHttpKeepAliveTimeout(http.createServer())).toBe(0);
    } finally {
      if (before === undefined) delete process.env[HTTP_KEEP_ALIVE_TIMEOUT_ENV];
      else process.env[HTTP_KEEP_ALIVE_TIMEOUT_ENV] = before;
    }
  });
});

describe("what a keep-alive client is told (#221)", () => {
  let server: http.Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function keepAliveHint(env: NodeJS.ProcessEnv): Promise<string | undefined> {
    server = http.createServer((_req, res) => res.end("ok"));
    applyHttpKeepAliveTimeout(server, env);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const agent = new http.Agent({ keepAlive: true });
    try {
      return await new Promise((resolve, reject) => {
        http
          .get({ host: "127.0.0.1", port, agent }, (res) => {
            res.resume();
            res.on("end", () => resolve(res.headers["keep-alive"]));
          })
          .on("error", reject);
      });
    } finally {
      agent.destroy();
    }
  }

  it("advertises Node's default idle timeout when unset", async () => {
    expect(await keepAliveHint({})).toBe(`timeout=${NODE_DEFAULT_MS / 1000}`);
  });

  it("advertises no idle timeout when set to 0 — the server never closes an idle socket", async () => {
    expect(await keepAliveHint({ [HTTP_KEEP_ALIVE_TIMEOUT_ENV]: "0" })).toBeUndefined();
  });

  it("advertises a configured idle timeout", async () => {
    expect(await keepAliveHint({ [HTTP_KEEP_ALIVE_TIMEOUT_ENV]: "65000" })).toBe("timeout=65");
  });
});

describe("createServer applies the setting to the server it listens on (#221)", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "server.ts"),
    "utf-8",
  );

  it("calls applyHttpKeepAliveTimeout(httpServer) right after creating it", () => {
    const created = source.indexOf("const httpServer = http.createServer(app);");
    const applied = [...source.matchAll(/^\s+applyHttpKeepAliveTimeout\(httpServer\);$/gm)];
    expect(created).toBeGreaterThan(-1);
    expect(applied).toHaveLength(1);
    expect(applied[0].index).toBeGreaterThan(created);
    expect(applied[0].index).toBeLessThan(source.indexOf("createSocketServer(httpServer"));
  });
});
