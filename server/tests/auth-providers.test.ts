/**
 * Auth provider tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAuthProvider } from "../src/lib/auth/mock-provider.js";
import { LDAPAuthProvider } from "../src/lib/auth/ldap-provider.js";
import { __resetAuthProvider, getAuthProvider } from "../src/lib/auth/providers.js";

beforeEach(() => {
  __resetAuthProvider();
  vi.stubEnv("AUTH_MODE", undefined);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  __resetAuthProvider();
  vi.unstubAllEnvs();
});

describe("MockAuthProvider", () => {
  const p = new MockAuthProvider();

  it("authenticates the four seed users with password 'password'", async () => {
    for (const u of ["admin", "coordinator", "developer", "reader"]) {
      const res = await p.authenticate(u, "password");
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.user.username).toBe(u);
      }
    }
  });

  it("rejects unknown users", async () => {
    const res = await p.authenticate("nobody", "password");
    expect(res.success).toBe(false);
  });

  it("rejects wrong password", async () => {
    const res = await p.authenticate("admin", "wrong");
    expect(res.success).toBe(false);
  });
});

describe("LDAPAuthProvider (unconfigured)", () => {
  it("returns a not-configured error when no LDAP settings exist", async () => {
    const p = new LDAPAuthProvider();
    const res = await p.authenticate("u", "p");
    expect(res.success).toBe(false);
  });
});

describe("getAuthProvider factory", () => {
  it("returns mock by default", () => {
    __resetAuthProvider();
    delete process.env.AUTH_MODE;
    expect(getAuthProvider().name).toBe("mock");
  });

  it("returns ldap when AUTH_MODE=ldap", () => {
    __resetAuthProvider();
    process.env.AUTH_MODE = "ldap";
    expect(getAuthProvider().name).toBe("ldap");
    __resetAuthProvider();
    delete process.env.AUTH_MODE;
  });

  it("falls back to mock with a warning for unknown modes", () => {
    __resetAuthProvider();
    process.env.AUTH_MODE = "unknown_xyz";
    expect(getAuthProvider().name).toBe("mock");
    __resetAuthProvider();
    delete process.env.AUTH_MODE;
  });

  it("returns SSO shim for saml mode", () => {
    __resetAuthProvider();
    process.env.AUTH_MODE = "saml";
    expect(getAuthProvider().name).toBe("saml");
    __resetAuthProvider();
    delete process.env.AUTH_MODE;
  });

  it("returns SSO shim for oidc mode", () => {
    __resetAuthProvider();
    process.env.AUTH_MODE = "oidc";
    expect(getAuthProvider().name).toBe("oidc");
    __resetAuthProvider();
    delete process.env.AUTH_MODE;
  });

  it("caches the provider", () => {
    __resetAuthProvider();
    const a = getAuthProvider();
    const b = getAuthProvider();
    expect(a).toBe(b);
  });
});

describe("getAuthProvider production fail-fast guard", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  const setProd = () => {
    // NODE_ENV is typed as readonly in some setups; assign via index to satisfy TS.
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  };

  afterEach(() => {
    __resetAuthProvider();
    delete process.env.AUTH_MODE;
    (process.env as Record<string, string | undefined>).NODE_ENV = originalNodeEnv;
  });

  it("throws in production when AUTH_MODE=mock", () => {
    setProd();
    process.env.AUTH_MODE = "mock";
    expect(() => getAuthProvider()).toThrow(/mock/i);
  });

  it("throws in production when AUTH_MODE is unset", () => {
    setProd();
    delete process.env.AUTH_MODE;
    expect(() => getAuthProvider()).toThrow(/production/i);
  });

  it("throws in production when AUTH_MODE is an unknown/typo value", () => {
    setProd();
    process.env.AUTH_MODE = "moc"; // typo of mock
    expect(() => getAuthProvider()).toThrow(/production/i);
  });

  it("throws in production when AUTH_MODE is an empty string", () => {
    setProd();
    process.env.AUTH_MODE = "";
    expect(() => getAuthProvider()).toThrow(/production/i);
  });

  it("throws in production when AUTH_MODE is whitespace-only", () => {
    setProd();
    process.env.AUTH_MODE = "   ";
    expect(() => getAuthProvider()).toThrow(/production/i);
  });

  it("does NOT throw in production for a real provider (ldap)", () => {
    setProd();
    process.env.AUTH_MODE = "ldap";
    expect(() => getAuthProvider().name).not.toThrow();
    expect(getAuthProvider().name).toBe("ldap");
  });

  it("does NOT throw in production for a real provider (saml)", () => {
    setProd();
    process.env.AUTH_MODE = "saml";
    expect(getAuthProvider().name).toBe("saml");
  });

  it("does NOT throw in production for a real provider (oidc) with surrounding whitespace", () => {
    setProd();
    process.env.AUTH_MODE = "  oidc  ";
    expect(getAuthProvider().name).toBe("oidc");
  });

  it("does NOT throw in production for a real provider with mixed case", () => {
    setProd();
    process.env.AUTH_MODE = "LDAP";
    expect(getAuthProvider().name).toBe("ldap");
  });

  it("allows mock in development (NODE_ENV=development)", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "development";
    process.env.AUTH_MODE = "mock";
    expect(getAuthProvider().name).toBe("mock");
  });

  it("allows mock in the test environment (NODE_ENV=test)", () => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "test";
    delete process.env.AUTH_MODE;
    expect(getAuthProvider().name).toBe("mock");
  });
});
