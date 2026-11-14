/**
 * #2344 — the remote endpoint over HTTP: metadata discovery, the 401/403
 * challenges, audience, user mapping, the transport hardening and the
 * no-passthrough rule, driven through Express with the real mounts.
 */
import { generateKeyPairSync } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const m = vi.hoisted(() => ({ dispatchIndexTool: vi.fn() }));
vi.mock("../dispatcher.js", async (original) => ({
  ...(await original<typeof import("../dispatcher.js")>()),
  dispatchIndexTool: m.dispatchIndexTool,
}));

const { mountRemoteMcp, mountRemoteMcpBodyLimit } = await import("../../../routes/mcp-remote.js");
const { jsonBodyParser } = await import("../../../middleware/body-parsers.js");
const { errorHandler } = await import("../../../middleware/error-handler.js");
const { bearerChallenge, MAX_REMOTE_BODY_BYTES, protectedResourceMetadata } =
  await import("./http.js");
const { createAccessTokenVerifier, InvalidAccessTokenError } = await import("./token-verifier.js");
type Deps = import("./http.js").RemoteMcpDeps;
type CreateServer = typeof import("../server.js").createIndexMcpServer;
type Settings = import("./config.js").RemoteMcpSettings;
type Config = import("./config.js").RemoteMcpConfig;

const RESOURCE = "https://metis.example.com/mcp";
const ISSUER = "https://idp.example.com";
const METADATA = "https://metis.example.com/.well-known/oauth-protected-resource/mcp";

function settings(over: Partial<Settings> = {}): Settings {
  return {
    resource: RESOURCE,
    metadataUrl: METADATA,
    issuer: ISSUER,
    jwksUrl: "https://idp.example.com/jwks",
    scope: "mcp:read",
    allowedOrigins: new Set(["https://agent.example.com"]),
    requireTls: true,
    rateLimitPerMinute: 1000,
    ...over,
  };
}

let userSeq = 0;
/** A fresh user per test: the rate-limit store is shared across the file. */
let user = "u0";
const audit = vi.fn();

/** Opaque test tokens → what the verifier says about them. */
function stubVerifier(scopes = ["mcp:read"]) {
  return vi.fn(async (token: string) => {
    if (token !== "good-token") throw new InvalidAccessTokenError("signature");
    return { issuer: ISSUER, subject: "sub-1", scopes, expiresAt: 9e9 };
  });
}

function makeApp(deps: Deps & { config?: Config } = {}) {
  const config = deps.config ?? { state: "enabled", settings: settings() };
  const full: Deps = {
    readConfig: () => config,
    verifyToken: stubVerifier(),
    mapUser: vi.fn(async () => ({ ok: true as const, userId: user })),
    audit,
    ...deps,
  };
  const app = express();
  app.set("trust proxy", 1);
  mountRemoteMcpBodyLimit(app, full);
  app.use(jsonBodyParser({ limit: "10mb" }));
  mountRemoteMcp(app, (_req, _res, next) => next(), full);
  app.use(errorHandler);
  return app;
}

const RPC_HEADERS = {
  accept: "application/json, text/event-stream",
  "content-type": "application/json",
  "x-forwarded-proto": "https",
};

function rpc(app: express.Express, body: unknown, headers: Record<string, string> = {}) {
  return request(app)
    .post("/mcp")
    .set({ ...RPC_HEADERS, authorization: "Bearer good-token", ...headers })
    .send(body as object);
}

/** POST `/mcp` with a chunked body (no content-length) to a listening server. */
async function postChunked(app: express.Express, body: string): Promise<number> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/mcp",
          headers: { ...RPC_HEADERS, authorization: "Bearer good-token" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      for (let i = 0; i < body.length; i += 8192) req.write(body.slice(i, i + 8192));
      req.end();
    });
  } finally {
    server.close();
  }
}

const listTools = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const callStatus = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: { name: "metis_index_status", arguments: { projectId: "p1" } },
};

beforeEach(() => {
  userSeq += 1;
  user = `u${userSeq}`;
  audit.mockReset();
  m.dispatchIndexTool.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("protected-resource metadata (RFC 9728)", () => {
  it("serves the document at the path-inserted URL and at the root", async () => {
    const app = makeApp();
    for (const path of [
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-protected-resource",
    ]) {
      const r = await request(app).get(path);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        scopes_supported: ["mcp:read"],
        bearer_methods_supported: ["header"],
        resource_name: "METIS index (metis-index-mcp)",
      });
    }
    expect(protectedResourceMetadata(settings())).toHaveProperty("resource", RESOURCE);
  });

  it("is not served while the endpoint is off or misconfigured", async () => {
    for (const config of [
      { state: "disabled" },
      { state: "misconfigured", problem: "x" },
    ] as Config[]) {
      const app = makeApp({ config });
      expect((await request(app).get("/.well-known/oauth-protected-resource/mcp")).status).toBe(
        404,
      );
    }
  });
});

describe("off by default", () => {
  it("answers 404 to every request while disabled, before any credential is read", async () => {
    const verifyToken = stubVerifier();
    const app = makeApp({ config: { state: "disabled" }, verifyToken });
    const r = await rpc(app, listTools);
    expect(r.status).toBe(404);
    expect(r.headers["www-authenticate"]).toBeUndefined();
    expect(verifyToken).not.toHaveBeenCalled();
  });

  it("answers 503 while misconfigured", async () => {
    const app = makeApp({
      config: { state: "misconfigured", problem: "MCP_REMOTE_ISSUER is not set" },
    });
    expect((await rpc(app, listTools)).status).toBe(503);
  });
});

describe("authorization", () => {
  it("challenges a request with no token: 401, resource_metadata, no error code", async () => {
    const r = await request(makeApp()).post("/mcp").set(RPC_HEADERS).send(listTools);
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toBe(
      `Bearer scope="mcp:read", resource_metadata="${METADATA}"`,
    );
  });

  it("refuses an invalid token with 401 invalid_token, and a non-bearer header the same way", async () => {
    const app = makeApp();
    for (const authorization of ["Bearer forged", "Basic dXNlcjpwYXNz", "Bearer "]) {
      const r = await rpc(app, listTools, { authorization });
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toMatch(/^Bearer error="invalid_token", /);
      expect(r.headers["www-authenticate"]).toContain(`resource_metadata="${METADATA}"`);
    }
    expect(m.dispatchIndexTool).not.toHaveBeenCalled();
  });

  it("refuses a static METIS API token: it is not an access token from the issuer", async () => {
    const app = makeApp({ verifyToken: createAccessTokenVerifier({ fetchImpl: vi.fn() }).verify });
    const r = await rpc(app, listTools, { authorization: "Bearer metis_abcdef0123456789" });
    expect(r.status).toBe(401);
  });

  describe("with real signatures", () => {
    const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwks = { keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "k1" }] };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 }));
    const sign = (aud: string) =>
      jwt.sign({ iss: ISSUER, aud, sub: "sub-1", scope: "mcp:read" }, keys.privateKey, {
        algorithm: "ES256",
        keyid: "k1",
        expiresIn: 300,
      });

    it("refuses a token minted for another audience, and serves one minted for this resource", async () => {
      const app = makeApp({ verifyToken: createAccessTokenVerifier({ fetchImpl }).verify });
      m.dispatchIndexTool.mockResolvedValue({ isError: true, message: "x" });
      const wrong = await rpc(app, listTools, {
        authorization: `Bearer ${sign("https://other.example.com/mcp")}`,
      });
      expect(wrong.status).toBe(401);
      expect(wrong.headers["www-authenticate"]).toContain('error="invalid_token"');
      const right = await rpc(app, listTools, { authorization: `Bearer ${sign(RESOURCE)}` });
      expect(right.status).toBe(200);
      expect(right.body.result.tools).toHaveLength(8);
    });
  });

  it("refuses a token without the read scope: 403 insufficient_scope naming the scope", async () => {
    const app = makeApp({ verifyToken: stubVerifier(["openid", "mcp:write"]) });
    const r = await rpc(app, listTools);
    expect(r.status).toBe(403);
    expect(r.headers["www-authenticate"]).toBe(
      `Bearer error="insufficient_scope", error_description="The access token needs the mcp:read scope.", scope="mcp:read", resource_metadata="${METADATA}"`,
    );
    expect(r.body).toMatchObject({ error: "insufficient_scope" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: { id: user },
        action: "mcp.index.denied",
        metadata: { transport: "remote", reason: "scope" },
      }),
    );
  });

  it("refuses a subject that maps to no active METIS user, and audits it", async () => {
    for (const reason of ["unmapped", "inactive"] as const) {
      const app = makeApp({ mapUser: async () => ({ ok: false, reason }) });
      const r = await rpc(app, listTools);
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toContain('error="invalid_token"');
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({ actor: null, metadata: { transport: "remote", reason } }),
      );
    }
    expect(m.dispatchIndexTool).not.toHaveBeenCalled();
  });

  it("passes a verifier or mapping failure to the error handler, not as a success", async () => {
    const boom = makeApp({ verifyToken: async () => Promise.reject(new Error("db down")) });
    expect((await rpc(boom, listTools)).status).toBe(500);
    const mapBoom = makeApp({ mapUser: async () => Promise.reject(new Error("db down")) });
    expect((await rpc(mapBoom, listTools)).status).toBe(500);
  });

  it("checks the token on every request: a session id is never the credential", async () => {
    const app = makeApp();
    const first = await rpc(app, listTools);
    expect(first.status).toBe(200);
    expect(first.headers["mcp-session-id"]).toBeUndefined();
    const second = await request(app)
      .post("/mcp")
      .set({ ...RPC_HEADERS, "mcp-session-id": "anything" })
      .send(listTools);
    expect(second.status).toBe(401);
  });

  it("escapes quotes out of challenge values", () => {
    expect(
      bearerChallenge(settings({ scope: 'a"b' }), { code: "invalid_token", description: 'x"y' }),
    ).toBe(
      `Bearer error="invalid_token", error_description="xy", scope="ab", resource_metadata="${METADATA}"`,
    );
  });
});

describe("tool calls", () => {
  it("runs a call as the mapped user through the dispatcher, audited as remote", async () => {
    const output = {
      tool: "metis_index_status",
      projectId: "p1",
      result: "indexed",
      resultCount: null,
      truncated: false,
      citations: [],
      instructions: null,
    };
    m.dispatchIndexTool.mockImplementation(async (_def, _args, env) => {
      env.audit({
        actor: { id: user },
        action: "mcp.index.tool_call",
        target: { type: "project", id: "p1" },
        metadata: { tool: "metis_index_status" },
      });
      return { isError: false, output };
    });
    const r = await rpc(makeApp(), callStatus);
    expect(r.status).toBe(200);
    expect(r.body.result.structuredContent).toEqual(output);
    const env = m.dispatchIndexTool.mock.calls[0]![2];
    await expect(env.verify(env.credential)).resolves.toEqual({
      tokenId: "oauth",
      userId: user,
      scopes: ["acp:read"],
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "mcp.index.tool_call",
        metadata: { tool: "metis_index_status", transport: "remote" },
      }),
    );
  });

  it("never hands the inbound token to the dispatcher, the SDK or a tool handler", async () => {
    const seen: unknown[] = [];
    const createServer: CreateServer = (opts) => {
      seen.push(JSON.stringify({ ...opts, verify: String(opts.verify) }));
      const s = new McpServer({ name: "probe", version: "0" });
      s.registerTool("probe", { inputSchema: { x: z.string().optional() } }, async (_a, extra) => {
        seen.push(JSON.stringify(extra.requestInfo ?? {}), JSON.stringify(extra.authInfo ?? null));
        return { content: [{ type: "text", text: "ok" }] };
      });
      return s;
    };
    const r = await rpc(makeApp({ createServer }), {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "probe", arguments: {} },
    });
    expect(r.status).toBe(200);
    expect(seen).toHaveLength(3);
    for (const s of seen) expect(s).not.toContain("good-token");
    expect(seen[1]).not.toContain("authorization");
    expect(seen[2]).toBe("null");
  });
});

describe("transport hardening", () => {
  it("requires TLS when the resource is https", async () => {
    const r = await rpc(makeApp(), listTools, { "x-forwarded-proto": "http" });
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "tls_required" });
  });

  it("accepts plain HTTP for a localhost resource", async () => {
    const app = makeApp({
      config: { state: "enabled", settings: settings({ requireTls: false }) },
    });
    expect((await rpc(app, listTools, { "x-forwarded-proto": "http" })).status).toBe(200);
  });

  it("refuses a browser Origin that is not allowed, and accepts an allowed one or none", async () => {
    const app = makeApp();
    for (const origin of ["https://evil.example.com", "null", "not a url"]) {
      const r = await rpc(app, listTools, { origin });
      expect(r.status).toBe(403);
      expect(r.body).toEqual({ error: "origin_not_allowed" });
    }
    expect((await rpc(app, listTools, { origin: "https://agent.example.com" })).status).toBe(200);
    expect((await rpc(app, listTools)).status).toBe(200);
  });

  it("limits each user per minute, separately", async () => {
    const app = makeApp({
      config: { state: "enabled", settings: settings({ rateLimitPerMinute: 2 }) },
    });
    expect((await rpc(app, listTools)).status).toBe(200);
    expect((await rpc(app, listTools)).status).toBe(200);
    const limited = await rpc(app, listTools);
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "rate_limited" });
    user = `${user}-other`;
    expect((await rpc(app, listTools)).status).toBe(200);
  });

  it("bounds the request body, by its declared length and as it streams", async () => {
    const app = makeApp();
    const big = { ...listTools, params: { pad: "x".repeat(MAX_REMOTE_BODY_BYTES) } };
    const r = await rpc(app, big);
    expect(r.status).toBe(413);
    // Chunked, so no content-length: the parser counts the body as it streams.
    expect(await postChunked(app, JSON.stringify(big))).toBe(413);
  });

  it("refuses a body that is not JSON (415)", async () => {
    const r = await request(makeApp())
      .post("/mcp")
      .set({ ...RPC_HEADERS, authorization: "Bearer good-token", "content-type": "text/plain" })
      .send("x".repeat(1000));
    expect(r.status).toBe(415);
  });

  it("is stateless: GET and DELETE answer 405 with Allow: POST", async () => {
    const app = makeApp();
    for (const method of ["get", "delete"] as const) {
      const r = await request(app)
        [method]("/mcp")
        .set({
          ...RPC_HEADERS,
          authorization: "Bearer good-token",
        });
      expect(r.status).toBe(405);
      expect(r.headers.allow).toBe("POST");
    }
  });

  it("leaves other paths alone while disabled", async () => {
    const app = makeApp({ config: { state: "disabled" } });
    const r = await request(app).post("/mcp").set({ "content-type": "text/plain" }).send("hello");
    expect(r.status).toBe(404);
  });
});
