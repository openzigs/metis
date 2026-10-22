/**
 * #1386 — the two small decisions behind a completed SSO login: where the
 * browser lands, and when METIS may talk to an IdP over plain HTTP.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ssoLandingUrl } from "../src/routes/sso.js";
import { allowsPlainHttpIdp } from "../src/lib/auth/oidc-provider.js";

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
    expect(allowsPlainHttpIdp(url("http://[::1]:4600/x"), undefined)).toBe(true);
  });

  it("never in production, never off loopback, and https needs no exception", () => {
    expect(allowsPlainHttpIdp(url("http://localhost:4600/x"), "production")).toBe(false);
    expect(allowsPlainHttpIdp(url("http://idp.example.com/x"), "development")).toBe(false);
    expect(allowsPlainHttpIdp(url("http://127.0.0.2/x"), "development")).toBe(false);
    expect(allowsPlainHttpIdp(url("https://localhost/x"), "development")).toBe(false);
  });
});
