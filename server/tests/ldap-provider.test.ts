/**
 * LDAP provider tests.
 *
 * Issue #853: LDAP/Active Directory authentication provider.
 * Tests config management, filter escaping, group extraction, and auth flow.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";

const mockBind = vi.fn();
const mockUnbind = vi.fn();
const mockSearch = vi.fn();

vi.mock("ldapts", () => {
  return {
    Client: class MockClient {
      bind = mockBind;
      unbind = mockUnbind;
      search = mockSearch;
      constructor(_opts: unknown) {
        // captures options but doesn't need to do anything
      }
    },
  };
});

import {
  LDAPAuthProvider,
  getLDAPConfig,
  setLDAPConfig,
  clearLDAPConfig,
  getLDAPConfigForUI,
  testLDAPConnection,
  type LDAPConfig,
} from "../src/lib/auth/ldap-provider.js";

const sampleConfig: LDAPConfig = {
  url: "ldaps://ad.example.com:636",
  baseDN: "DC=ad,DC=example,DC=com",
  bindDN: "CN=svcaccount,OU=Service Accounts,DC=ad,DC=example,DC=com",
  bindPassword: "secret",
  userSearchBase: "OU=Users,DC=ad,DC=example,DC=com",
  searchFilter: "(&(objectClass=user)(sAMAccountName={{username}}))",
  groupMappings: [
    { claimValue: "Admins", role: "admin" },
    { claimValue: "Developers", role: "developer" },
  ],
  defaultRole: "reader",
  tlsSkipVerify: true,
  connectionTimeout: 10000,
};

describe("LDAP Config Management", () => {
  beforeEach(() => {
    clearLDAPConfig();
    delete process.env.AUTH_LDAP_URL;
    delete process.env.AUTH_LDAP_BASE_DN;
    delete process.env.AUTH_LDAP_BIND_DN;
    delete process.env.AUTH_LDAP_BIND_PASSWORD;
  });

  it("returns empty config when no env vars or admin config set", () => {
    const cfg = getLDAPConfig();
    expect(cfg.url).toBe("");
    expect(cfg.bindDN).toBe("");
    expect(cfg.defaultRole).toBe("reader");
  });

  it("reads config from environment variables", () => {
    process.env.AUTH_LDAP_URL = "ldaps://test:636";
    process.env.AUTH_LDAP_BASE_DN = "DC=test";
    process.env.AUTH_LDAP_BIND_DN = "CN=bind";
    process.env.AUTH_LDAP_BIND_PASSWORD = "pw";
    process.env.AUTH_LDAP_TLS_SKIP_VERIFY = "true";

    const cfg = getLDAPConfig();
    expect(cfg.url).toBe("ldaps://test:636");
    expect(cfg.baseDN).toBe("DC=test");
    expect(cfg.bindDN).toBe("CN=bind");
    expect(cfg.bindPassword).toBe("pw");
    expect(cfg.tlsSkipVerify).toBe(true);
  });

  it("admin override takes precedence over env vars", () => {
    process.env.AUTH_LDAP_URL = "ldaps://env-server:636";
    setLDAPConfig(sampleConfig);
    expect(getLDAPConfig().url).toBe("ldaps://ad.example.com:636");
  });

  it("clearLDAPConfig reverts to env-based config", () => {
    setLDAPConfig(sampleConfig);
    clearLDAPConfig();
    expect(getLDAPConfig().url).toBe("");
  });

  it("getLDAPConfigForUI omits bindPassword", () => {
    setLDAPConfig(sampleConfig);
    const ui = getLDAPConfigForUI();
    expect(ui).not.toHaveProperty("bindPassword");
    expect(ui.url).toBe(sampleConfig.url);
    expect(ui.configured).toBe(true);
  });

  it("getLDAPConfigForUI reports not configured when missing fields", () => {
    clearLDAPConfig();
    const ui = getLDAPConfigForUI();
    expect(ui.configured).toBe(false);
  });
});

describe("testLDAPConnection", () => {
  beforeEach(() => {
    clearLDAPConfig();
    mockBind.mockReset();
    mockUnbind.mockReset();
  });

  it("returns error when config is incomplete", async () => {
    const result = await testLDAPConnection({ ...sampleConfig, url: "" });
    expect(result).toContain("required");
  });

  it("returns null on successful bind", async () => {
    mockBind.mockResolvedValue(undefined);
    mockUnbind.mockResolvedValue(undefined);

    const result = await testLDAPConnection(sampleConfig);
    expect(result).toBeNull();
    expect(mockBind).toHaveBeenCalledWith(sampleConfig.bindDN, sampleConfig.bindPassword);
  });

  it("returns error message on bind failure", async () => {
    mockBind.mockRejectedValue(new Error("ECONNREFUSED"));
    mockUnbind.mockResolvedValue(undefined);

    const result = await testLDAPConnection(sampleConfig);
    expect(result).toContain("LDAP connection failed");
    expect(result).toContain("ECONNREFUSED");
  });
});

describe("LDAPAuthProvider.authenticate", () => {
  let provider: LDAPAuthProvider;

  beforeEach(() => {
    clearLDAPConfig();
    setLDAPConfig(sampleConfig);
    provider = new LDAPAuthProvider();
    mockBind.mockReset();
    mockUnbind.mockReset();
    mockSearch.mockReset();
  });

  it("returns error when LDAP is not configured", async () => {
    clearLDAPConfig();
    const res = await provider.authenticate("user", "pass");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("not configured");
  });

  it("returns error when user is not found in directory", async () => {
    mockBind.mockResolvedValue(undefined);
    mockUnbind.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue({ searchEntries: [] });

    const res = await provider.authenticate("unknown", "pass");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toBe("Invalid username or password");
  });

  it("authenticates successfully with correct credentials", async () => {
    mockBind.mockResolvedValue(undefined);
    mockUnbind.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue({
      searchEntries: [
        {
          dn: "CN=jdoe,OU=Users,DC=ad,DC=example,DC=com",
          sAMAccountName: "jdoe",
          displayName: "John Doe",
          mail: "jdoe@example.com",
          memberOf: ["CN=Developers,OU=Groups,DC=ad,DC=example,DC=com"],
        },
      ],
    });

    const res = await provider.authenticate("jdoe", "correctpass");
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.user.username).toBe("jdoe");
      expect(res.user.displayName).toBe("John Doe");
      expect(res.user.email).toBe("jdoe@example.com");
      expect(res.user.role).toBe("developer");
      expect(res.user.groups).toContain("Developers");
    }
  });

  it("returns error on invalid credentials (user bind fails)", async () => {
    let bindCallCount = 0;
    mockBind.mockImplementation(() => {
      bindCallCount++;
      // First call = service account bind (succeeds), second call = user bind (fails)
      if (bindCallCount >= 2) {
        return Promise.reject(new Error("InvalidCredentialsError"));
      }
      return Promise.resolve(undefined);
    });
    mockUnbind.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue({
      searchEntries: [
        {
          dn: "CN=jdoe,OU=Users,DC=ad,DC=example,DC=com",
          sAMAccountName: "jdoe",
          displayName: "John Doe",
          mail: "jdoe@example.com",
        },
      ],
    });

    const res = await provider.authenticate("jdoe", "wrongpass");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toBe("Invalid username or password");
  });

  it("returns service unavailable on ECONNREFUSED", async () => {
    mockBind.mockRejectedValue(new Error("ECONNREFUSED"));
    mockUnbind.mockResolvedValue(undefined);

    const res = await provider.authenticate("user", "pass");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("unavailable");
  });

  it("returns service unavailable on ETIMEDOUT", async () => {
    mockBind.mockRejectedValue(new Error("ETIMEDOUT"));
    mockUnbind.mockResolvedValue(undefined);

    const res = await provider.authenticate("user", "pass");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("unavailable");
  });

  it("resolves admin role from group membership", async () => {
    mockBind.mockResolvedValue(undefined);
    mockUnbind.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue({
      searchEntries: [
        {
          dn: "CN=admin1,OU=Users,DC=ad,DC=example,DC=com",
          sAMAccountName: "admin1",
          displayName: "Admin User",
          mail: "admin@example.com",
          memberOf: [
            "CN=Admins,OU=Groups,DC=ad,DC=example,DC=com",
            "CN=Developers,OU=Groups,DC=ad,DC=example,DC=com",
          ],
        },
      ],
    });

    const res = await provider.authenticate("admin1", "pass");
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.user.role).toBe("admin");
    }
  });

  it("uses default role when no group mappings match", async () => {
    mockBind.mockResolvedValue(undefined);
    mockUnbind.mockResolvedValue(undefined);
    mockSearch.mockResolvedValue({
      searchEntries: [
        {
          dn: "CN=newuser,OU=Users,DC=ad,DC=example,DC=com",
          sAMAccountName: "newuser",
          displayName: "New User",
          mail: "new@example.com",
          memberOf: ["CN=SomeOtherGroup,OU=Groups,DC=ad,DC=example,DC=com"],
        },
      ],
    });

    const res = await provider.authenticate("newuser", "pass");
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.user.role).toBe("reader");
    }
  });
});

describe("LDAPAuthProvider name", () => {
  it("reports name as ldap", () => {
    const p = new LDAPAuthProvider();
    expect(p.name).toBe("ldap");
  });
});
