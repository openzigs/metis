/**
 * #2344 — the remote MCP endpoint as `createApp()` mounts it: off by default,
 * at the top level, and with its body bounded before the app's global 10 MiB parser.
 */
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { MAX_REMOTE_BODY_BYTES } from "../mcp/metis-index/remote/http.js";
import type { RemoteMcpConfig } from "../mcp/metis-index/remote/config.js";

const enabled: RemoteMcpConfig = {
  state: "enabled",
  settings: {
    resource: "https://metis.example.com/mcp",
    metadataUrl: "https://metis.example.com/.well-known/oauth-protected-resource/mcp",
    issuer: "https://idp.example.com",
    jwksUrl: "https://idp.example.com/jwks",
    scope: "mcp:read",
    allowedOrigins: new Set(),
    requireTls: false,
    rateLimitPerMinute: 1000,
  },
};

describe("createApp: remote MCP mounts", () => {
  it("serves neither the endpoint nor its metadata with the settings at their defaults", async () => {
    const app = createApp();
    expect((await request(app).post("/mcp").send({})).status).toBe(404);
    expect((await request(app).get("/.well-known/oauth-protected-resource/mcp")).status).toBe(404);
  });

  it("when enabled, serves the metadata and challenges an unauthenticated call", async () => {
    const app = createApp({ remoteMcp: { readConfig: () => enabled } });
    const meta = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(meta.status).toBe(200);
    expect(meta.body.resource).toBe("https://metis.example.com/mcp");
    const r = await request(app).post("/mcp").send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(r.status).toBe(401);
    expect(r.headers["www-authenticate"]).toContain("resource_metadata=");
  });

  it("bounds the body below the global parser's limit, before authentication", async () => {
    const verifyToken = vi.fn();
    const app = createApp({ remoteMcp: { readConfig: () => enabled, verifyToken } });
    const r = await request(app)
      .post("/mcp")
      .set("authorization", "Bearer x")
      .send({ pad: "x".repeat(MAX_REMOTE_BODY_BYTES) });
    expect(r.status).toBe(413);
    expect(verifyToken).not.toHaveBeenCalled();
  });
});

// MCP_REMOTE_ALLOWED_ORIGINS is a DNS-rebinding allowlist, not CORS: the
// endpoint answers no origin with Access-Control-* headers — not one it allows,
// and not the UI's own CORS_ORIGIN, whose credentialed CORS stays on /api.
describe("createApp: remote MCP and CORS", () => {
  const ui = "https://ui.example.com";
  const agent = "https://agent.example.com";
  const withOrigins: RemoteMcpConfig = {
    ...enabled,
    settings: { ...enabled.settings, allowedOrigins: new Set([agent]) },
  };
  const app = () => createApp({ corsOrigin: ui, remoteMcp: { readConfig: () => withOrigins } });
  const preflight = (path: string, origin: string) =>
    request(app())
      .options(path)
      .set("origin", origin)
      .set("access-control-request-method", "POST")
      .set("access-control-request-headers", "authorization, content-type");

  it("answers a preflight from an allowed MCP origin with no CORS grant", async () => {
    const r = await preflight("/mcp", agent);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers a preflight from the UI's CORS origin on /mcp with no CORS grant", async () => {
    const r = await preflight("/mcp", ui);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    expect(r.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("refuses an actual call from the UI's origin when it is not an allowed MCP origin", async () => {
    const r = await request(app()).post("/mcp").set("origin", ui).send({});
    expect(r.status).toBe(403);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("grants no CORS on the endpoint however the path is cased (Express routes /MCP to it)", async () => {
    for (const path of ["/MCP", "/Mcp/"]) {
      const r = await preflight(path, ui);
      expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("answers a disallowed origin with no CORS grant", async () => {
    const r = await preflight("/mcp", "https://evil.example.com");
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("leaves the global CORS for /api unchanged", async () => {
    const r = await preflight("/api/health", ui);
    expect(r.headers["access-control-allow-origin"]).toBe(ui);
    expect(r.headers["access-control-allow-credentials"]).toBe("true");
    const other = await preflight("/api/health", agent);
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("keeps CORS on a path that only starts with the letters mcp", async () => {
    const r = await preflight("/mcpx", ui);
    expect(r.headers["access-control-allow-origin"]).toBe(ui);
  });
});
