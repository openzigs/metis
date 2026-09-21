/**
 * Tests for SSO provider factory and shim.
 * Epic #748, Issues #749, #750.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { __resetAuthProvider, getAuthProvider } from "../src/lib/auth/providers.js";
import { SSOAuthProviderShim } from "../src/lib/auth/sso-auth-shim.js";

describe("SSOAuthProviderShim", () => {
  it("has correct name for saml mode", () => {
    const shim = new SSOAuthProviderShim("saml");
    expect(shim.name).toBe("saml");
  });

  it("has correct name for oidc mode", () => {
    const shim = new SSOAuthProviderShim("oidc");
    expect(shim.name).toBe("oidc");
  });

  it("rejects username/password auth with informative error for SAML", async () => {
    const shim = new SSOAuthProviderShim("saml");
    const result = await shim.authenticate("user", "pass");
    expect(result.success).toBe(false);
    expect(result.error).toContain("SSO login flow");
    expect(result.error).toContain("saml");
  });

  it("rejects username/password auth with informative error for OIDC", async () => {
    const shim = new SSOAuthProviderShim("oidc");
    const result = await shim.authenticate("user", "pass");
    expect(result.success).toBe(false);
    expect(result.error).toContain("SSO login flow");
    expect(result.error).toContain("oidc");
  });
});

describe("getAuthProvider factory (SSO modes)", () => {
  beforeEach(() => {
    __resetAuthProvider();
  });

  afterEach(() => {
    __resetAuthProvider();
    delete process.env.AUTH_MODE;
  });

  it("returns saml shim when AUTH_MODE=saml", () => {
    process.env.AUTH_MODE = "saml";
    const provider = getAuthProvider();
    expect(provider.name).toBe("saml");
  });

  it("returns oidc shim when AUTH_MODE=oidc", () => {
    process.env.AUTH_MODE = "oidc";
    const provider = getAuthProvider();
    expect(provider.name).toBe("oidc");
  });

  it("still returns mock when AUTH_MODE=mock", () => {
    process.env.AUTH_MODE = "mock";
    const provider = getAuthProvider();
    expect(provider.name).toBe("mock");
  });

  it("still returns ldap when AUTH_MODE=ldap", () => {
    process.env.AUTH_MODE = "ldap";
    const provider = getAuthProvider();
    expect(provider.name).toBe("ldap");
  });
});
