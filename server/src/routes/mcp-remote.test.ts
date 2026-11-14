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
