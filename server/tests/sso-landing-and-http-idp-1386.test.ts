/**
 * #1386 — the two small decisions behind a completed SSO login: where the
 * browser lands, and when METIS may talk to an IdP over plain HTTP.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ssoLandingUrl } from "../src/routes/sso.js";
import { allowsPlainHttpIdp, loopbackOnlyHttpFetch } from "../src/lib/auth/oidc-provider.js";

afterEach(() => vi.unstubAllEnvs());

describe("ssoLandingUrl", () => {
  it("prefers APP_URL, reduced to its origin", () => {
    vi.stubEnv("APP_URL", "https://metis.example.com/ignored/path");
    vi.stubEnv("CORS_ORIGIN", "https://other.example.com");
    expect(ssoLandingUrl()).toBe("https://metis.example.com/dashboard");
  });

  it("falls back to the first CORS_ORIGIN entry — what the Helm install sets", () => {
    vi.stubEnv("APP_URL", "");
    vi.stubEnv("CORS_ORIGIN", " https://metis.example.com , https://b.example.com");
    expect(ssoLandingUrl()).toBe("https://metis.example.com/dashboard");
  });

  it("falls back to the dev UI when neither names an http(s) origin", () => {
    vi.stubEnv("APP_URL", "javascript:alert(1)");
    vi.stubEnv("CORS_ORIGIN", "");
    expect(ssoLandingUrl()).toBe("http://localhost:3000/dashboard");
  });
});

describe("allowsPlainHttpIdp", () => {
  const url = (u: string) => new URL(u);

  it("allows http only for a loopback IdP outside production", () => {
    expect(allowsPlainHttpIdp(url("http://localhost:4600/x"), "development")).toBe(true);
    expect(allowsPlainHttpIdp(url("http://127.0.0.1:4600/x"), "test")).toBe(true);
    expect(allowsPlainHttpIdp(url("http://[::1]:4600/x"), "development")).toBe(true);
  });

  it("treats an unset or unknown NODE_ENV as production (#1393 review)", () => {
    vi.stubEnv("NODE_ENV", "");
    expect(allowsPlainHttpIdp(url("http://localhost:4600/x"))).toBe(false);
    expect(allowsPlainHttpIdp(url("http://localhost:4600/x"), "")).toBe(false);
    expect(allowsPlainHttpIdp(url("http://localhost:4600/x"), "staging")).toBe(false);
  });

  it("never in production, never off loopback, and https needs no exception", () => {
    expect(allowsPlainHttpIdp(url("http://localhost:4600/x"), "production")).toBe(false);
    expect(allowsPlainHttpIdp(url("http://idp.example.com/x"), "development")).toBe(false);
    expect(allowsPlainHttpIdp(url("http://127.0.0.2/x"), "development")).toBe(false);
    expect(allowsPlainHttpIdp(url("https://localhost/x"), "development")).toBe(false);
  });
});

describe("loopbackOnlyHttpFetch (#1393 review)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses plain HTTP to a non-loopback host, so a loopback discovery document cannot send the client secret elsewhere", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      loopbackOnlyHttpFetch("http://idp.example.test/token", {} as never),
    ).rejects.toThrow(/non-loopback host idp\.example\.test/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes loopback HTTP and any HTTPS through", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    await loopbackOnlyHttpFetch("http://127.0.0.1:4600/token", {} as never);
    await loopbackOnlyHttpFetch("https://idp.example.test/jwks", {} as never);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
