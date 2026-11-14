/**
 * #2344 — the remote endpoint is off by default, and on only with settings that hold together.
 */
import { describe, expect, it } from "vitest";
import { isLoopbackHost, readRemoteMcpConfig, REMOTE_KEYS } from "./config.js";

function svc(values: Record<string, string | undefined>) {
  return {
    get: (k: string) => values[k],
    getBool: (k: string, d = false) => (values[k] === undefined ? d : values[k] === "true"),
    getNumber: (k: string, d?: number) =>
      values[k] === undefined ? (d as number) : Number.parseInt(values[k]!, 10),
  };
}

const good = {
  [REMOTE_KEYS.ENABLED]: "true",
  [REMOTE_KEYS.RESOURCE_URL]: "https://metis.example.com/mcp",
  [REMOTE_KEYS.ISSUER]: "https://idp.example.com/realms/metis",
  [REMOTE_KEYS.JWKS_URL]: "https://idp.example.com/realms/metis/certs",
};

describe("readRemoteMcpConfig", () => {
  it("is disabled when the flag is unset or false", () => {
    expect(readRemoteMcpConfig(svc({}))).toEqual({ state: "disabled" });
    expect(readRemoteMcpConfig(svc({ ...good, [REMOTE_KEYS.ENABLED]: "false" }))).toEqual({
      state: "disabled",
    });
  });

  it("reads a complete https configuration, with the defaults", () => {
    const cfg = readRemoteMcpConfig(
      svc({ ...good, [REMOTE_KEYS.ALLOWED_ORIGINS]: "https://app.example.com/, junk" }),
    );
    expect(cfg).toEqual({
      state: "enabled",
      settings: {
        resource: "https://metis.example.com/mcp",
        metadataUrl: "https://metis.example.com/.well-known/oauth-protected-resource/mcp",
        issuer: "https://idp.example.com/realms/metis",
        jwksUrl: "https://idp.example.com/realms/metis/certs",
        scope: "mcp:read",
        allowedOrigins: new Set(["https://app.example.com"]),
        requireTls: true,
        rateLimitPerMinute: 60,
      },
    });
  });

  it("drops one trailing slash from the resource and keeps the issuer exactly as written", () => {
    const cfg = readRemoteMcpConfig(
      svc({
        ...good,
        [REMOTE_KEYS.RESOURCE_URL]: "https://metis.example.com/mcp/",
        [REMOTE_KEYS.ISSUER]: "https://idp.example.com/",
        [REMOTE_KEYS.SCOPE]: "metis.index.read",
        [REMOTE_KEYS.RATE_LIMIT]: "5",
      }),
    );
    expect(cfg.state === "enabled" && cfg.settings).toMatchObject({
      resource: "https://metis.example.com/mcp",
      issuer: "https://idp.example.com/",
      scope: "metis.index.read",
      rateLimitPerMinute: 5,
    });
  });

  it("allows plain http only for a localhost resource, and then does not require TLS", () => {
    const local = readRemoteMcpConfig(
      svc({
        ...good,
        [REMOTE_KEYS.RESOURCE_URL]: "http://localhost:4000/mcp",
        [REMOTE_KEYS.ISSUER]: "http://127.0.0.1:8080/realms/dev",
        [REMOTE_KEYS.JWKS_URL]: "http://[::1]:8080/certs",
      }),
    );
    expect(local.state === "enabled" && local.settings.requireTls).toBe(false);
  });

  it.each([
    [REMOTE_KEYS.RESOURCE_URL, undefined, "is not set"],
    [REMOTE_KEYS.RESOURCE_URL, "not a url", "is not a URL"],
    [REMOTE_KEYS.RESOURCE_URL, "http://metis.example.com/mcp", "must be https"],
    [REMOTE_KEYS.RESOURCE_URL, "ftp://metis.example.com/mcp", "must be https"],
    [REMOTE_KEYS.RESOURCE_URL, "https://metis.example.com/other", "must end in /mcp"],
    [REMOTE_KEYS.RESOURCE_URL, "https://metis.example.com/mcp?x=1", "query or fragment"],
    [REMOTE_KEYS.ISSUER, "http://idp.example.com", "must be https"],
    [REMOTE_KEYS.ISSUER, undefined, "is not set"],
    [REMOTE_KEYS.JWKS_URL, "http://idp.example.com/certs", "must be https"],
    [REMOTE_KEYS.SCOPE, "two scopes", "one scope token"],
  ])("is misconfigured when %s is %s", (key, value, problem) => {
    const cfg = readRemoteMcpConfig(svc({ ...good, [key]: value }));
    expect(cfg.state).toBe("misconfigured");
    expect(cfg.state === "misconfigured" && cfg.problem).toContain(problem);
  });

  it("never lets a rate limit below one through", () => {
    const cfg = readRemoteMcpConfig(svc({ ...good, [REMOTE_KEYS.RATE_LIMIT]: "0" }));
    expect(cfg.state === "enabled" && cfg.settings.rateLimitPerMinute).toBe(1);
  });
});

describe("isLoopbackHost", () => {
  it("knows this machine's names only", () => {
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("localhost.example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });
});
