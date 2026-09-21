import { describe, it, expect } from "vitest";
import {
  DEFAULTS,
  DEFAULT_GROUP_MAPPINGS,
  SEED_USERS,
  trimSlash,
  userDn,
  groupDn,
  buildLdapEnvBlock,
  renderEnvExport,
  resolveRoleForGroups,
  expectedRoleForUser,
  buildLdapProviderBody,
} from "./ldap-harness.mjs";

describe("trimSlash", () => {
  it("removes a single trailing slash", () => {
    expect(trimSlash("ldap://localhost:4400/")).toBe("ldap://localhost:4400");
  });

  it("removes multiple trailing slashes", () => {
    expect(trimSlash("ldap://localhost:4400///")).toBe("ldap://localhost:4400");
  });

  it("leaves a URL without a trailing slash unchanged", () => {
    expect(trimSlash("ldap://localhost:4400")).toBe("ldap://localhost:4400");
  });

  it("throws on a non-string", () => {
    expect(() => trimSlash(undefined)).toThrow(TypeError);
  });
});

describe("userDn / groupDn", () => {
  it("builds a uid-keyed user DN under the default users OU", () => {
    expect(userDn("alice")).toBe("uid=alice,ou=users,dc=metis,dc=local");
  });

  it("builds a cn-keyed group DN under the default groups OU", () => {
    expect(groupDn("metis-admins")).toBe("cn=metis-admins,ou=groups,dc=metis,dc=local");
  });

  it("honours custom search bases", () => {
    expect(userDn("alice", "ou=people,dc=x")).toBe("uid=alice,ou=people,dc=x");
    expect(groupDn("g", "ou=teams,dc=x")).toBe("cn=g,ou=teams,dc=x");
  });

  it("throws on a blank uid or cn", () => {
    expect(() => userDn("")).toThrow(/uid is required/);
    expect(() => userDn("   ")).toThrow(/uid is required/);
    expect(() => groupDn("")).toThrow(/cn is required/);
    expect(() => groupDn(undefined)).toThrow(/cn is required/);
  });
});

describe("buildLdapEnvBlock", () => {
  it("emits exactly the AUTH_LDAP_* names the provider reads, plus AUTH_MODE", () => {
    const env = buildLdapEnvBlock();
    expect(Object.keys(env).sort()).toEqual(
      [
        "AUTH_LDAP_BASE_DN",
        "AUTH_LDAP_BIND_DN",
        "AUTH_LDAP_BIND_PASSWORD",
        "AUTH_LDAP_CONNECTION_TIMEOUT",
        "AUTH_LDAP_SEARCH_FILTER",
        "AUTH_LDAP_TLS_SKIP_VERIFY",
        "AUTH_LDAP_URL",
        "AUTH_LDAP_USER_SEARCH_BASE",
        "AUTH_MODE",
      ].sort(),
    );
  });

  it("uses the local OpenLDAP defaults", () => {
    const env = buildLdapEnvBlock();
    expect(env).toMatchObject({
      AUTH_MODE: "ldap",
      AUTH_LDAP_URL: "ldap://localhost:4400",
      AUTH_LDAP_BASE_DN: "dc=metis,dc=local",
      AUTH_LDAP_BIND_DN: "cn=admin,dc=metis,dc=local",
      AUTH_LDAP_BIND_PASSWORD: "adminpassword",
      AUTH_LDAP_USER_SEARCH_BASE: "ou=users,dc=metis,dc=local",
      AUTH_LDAP_SEARCH_FILTER: "(&(objectClass=inetOrgPerson)(uid={{username}}))",
      AUTH_LDAP_TLS_SKIP_VERIFY: "false",
      AUTH_LDAP_CONNECTION_TIMEOUT: "10000",
    });
  });

  it("the default search filter overrides the provider's AD default and keeps {{username}}", () => {
    const env = buildLdapEnvBlock();
    expect(env.AUTH_LDAP_SEARCH_FILTER).toContain("inetOrgPerson");
    expect(env.AUTH_LDAP_SEARCH_FILTER).toContain("{{username}}");
    expect(env.AUTH_LDAP_SEARCH_FILTER).not.toContain("sAMAccountName");
  });

  it("works with no argument and honours overrides (incl. tlsSkipVerify + numeric timeout)", () => {
    expect(() => buildLdapEnvBlock()).not.toThrow();
    const env = buildLdapEnvBlock({
      url: "ldap://ldap.test:1389",
      baseDN: "dc=corp",
      bindDN: "cn=svc,dc=corp",
      bindPassword: "s3cret",
      userSearchBase: "ou=people,dc=corp",
      searchFilter: "(uid={{username}})",
      tlsSkipVerify: true,
      connectionTimeout: 5000,
    });
    expect(env.AUTH_LDAP_URL).toBe("ldap://ldap.test:1389");
    expect(env.AUTH_LDAP_BASE_DN).toBe("dc=corp");
    expect(env.AUTH_LDAP_BIND_DN).toBe("cn=svc,dc=corp");
    expect(env.AUTH_LDAP_BIND_PASSWORD).toBe("s3cret");
    expect(env.AUTH_LDAP_USER_SEARCH_BASE).toBe("ou=people,dc=corp");
    expect(env.AUTH_LDAP_SEARCH_FILTER).toBe("(uid={{username}})");
    expect(env.AUTH_LDAP_TLS_SKIP_VERIFY).toBe("true");
    expect(env.AUTH_LDAP_CONNECTION_TIMEOUT).toBe("5000");
  });

  it("throws on a blank bind password", () => {
    expect(() => buildLdapEnvBlock({ bindPassword: "" })).toThrow(/bindPassword is required/);
    expect(() => buildLdapEnvBlock({ bindPassword: "   " })).toThrow(/bindPassword/);
  });

  it("falls back to the default password when bindPassword is null/undefined", () => {
    expect(buildLdapEnvBlock({ bindPassword: null }).AUTH_LDAP_BIND_PASSWORD).toBe(
      DEFAULTS.bindPassword,
    );
    expect(buildLdapEnvBlock({ bindPassword: undefined }).AUTH_LDAP_BIND_PASSWORD).toBe(
      DEFAULTS.bindPassword,
    );
  });

  it("throws when the search filter is missing the {{username}} placeholder", () => {
    expect(() => buildLdapEnvBlock({ searchFilter: "(uid=alice)" })).toThrow(/\{\{username\}\}/);
  });
});

describe("renderEnvExport", () => {
  it("renders quoted export lines for each var", () => {
    const out = renderEnvExport({ A: "1", B: "two" });
    expect(out).toBe('export A="1"\nexport B="two"');
  });

  it("escapes embedded quotes and backslashes so DNs survive a shell", () => {
    const out = renderEnvExport({ DN: 'cn=a"b\\c' });
    expect(out).toBe('export DN="cn=a\\"b\\\\c"');
  });

  it("round-trips the full env block without throwing", () => {
    const out = renderEnvExport(buildLdapEnvBlock());
    expect(out).toContain('export AUTH_MODE="ldap"');
    expect(out).toContain('export AUTH_LDAP_URL="ldap://localhost:4400"');
  });

  it("throws on a non-object", () => {
    expect(() => renderEnvExport(null)).toThrow(TypeError);
    expect(() => renderEnvExport("nope")).toThrow(TypeError);
  });
});

describe("resolveRoleForGroups (mirrors server resolveRoleFromGroups)", () => {
  const mappings = [
    { claimValue: "metis-admins", role: "admin" },
    { claimValue: "metis-developers", role: "developer" },
  ];

  it("returns defaultRole when there are no mappings", () => {
    expect(resolveRoleForGroups(["metis-admins"], [], "reader")).toBe("reader");
  });

  it("returns defaultRole when the user has no groups", () => {
    expect(resolveRoleForGroups([], mappings, "reader")).toBe("reader");
  });

  it("maps a matched group to its role", () => {
    expect(resolveRoleForGroups(["metis-developers"], mappings, "reader")).toBe("developer");
  });

  it("returns the highest-privilege matched role", () => {
    expect(resolveRoleForGroups(["metis-developers", "metis-admins"], mappings, "reader")).toBe(
      "admin",
    );
  });

  it("keeps defaultRole when a matched role is lower privilege than the default", () => {
    expect(resolveRoleForGroups(["metis-developers"], mappings, "coordinator")).toBe("coordinator");
  });

  it("ignores unknown group names", () => {
    expect(resolveRoleForGroups(["nope"], mappings, "reader")).toBe("reader");
  });

  it("treats an unknown default/role level as 0", () => {
    // unknown defaultRole → level 0; any matched mapping wins
    expect(resolveRoleForGroups(["metis-developers"], mappings, "ghost")).toBe("developer");
    // unknown mapping role → level 0; never beats a known default
    expect(resolveRoleForGroups(["x"], [{ claimValue: "x", role: "ghost" }], "reader")).toBe(
      "reader",
    );
  });

  it("throws on non-array inputs", () => {
    expect(() => resolveRoleForGroups("a", mappings, "reader")).toThrow(TypeError);
    expect(() => resolveRoleForGroups([], "m", "reader")).toThrow(TypeError);
  });
});

describe("expectedRoleForUser", () => {
  it("resolves each seeded user to its expected role with the default mappings", () => {
    for (const user of SEED_USERS) {
      expect(expectedRoleForUser(user)).toBe(user.expectedRole);
    }
  });

  it("alice -> admin, bob -> developer (sanity)", () => {
    const alice = SEED_USERS.find((u) => u.uid === "alice");
    const bob = SEED_USERS.find((u) => u.uid === "bob");
    expect(expectedRoleForUser(alice)).toBe("admin");
    expect(expectedRoleForUser(bob)).toBe("developer");
  });

  it("falls back to defaultRole for a user in no mapped group", () => {
    expect(expectedRoleForUser({ groups: ["random"] })).toBe(DEFAULTS.defaultRole);
  });

  it("honours custom mappings and default role", () => {
    expect(
      expectedRoleForUser({ groups: ["ops"] }, [{ claimValue: "ops", role: "admin" }], "reader"),
    ).toBe("admin");
  });

  it("throws when user.groups is not an array", () => {
    expect(() => expectedRoleForUser({})).toThrow(TypeError);
    expect(() => expectedRoleForUser(null)).toThrow(TypeError);
  });
});

describe("buildLdapProviderBody (admin-API path that enables group->role)", () => {
  it("builds a body with the local defaults and default mappings", () => {
    const body = buildLdapProviderBody();
    expect(body).toMatchObject({
      url: DEFAULTS.url,
      baseDN: DEFAULTS.baseDN,
      bindDN: DEFAULTS.bindDN,
      bindPassword: DEFAULTS.bindPassword,
      userSearchBase: DEFAULTS.userSearchBase,
      searchFilter: DEFAULTS.searchFilter,
      defaultRole: DEFAULTS.defaultRole,
      tlsSkipVerify: false,
      connectionTimeout: DEFAULTS.connectionTimeout,
    });
    expect(body.groupMappings).toEqual([
      { claimValue: "metis-admins", role: "admin" },
      { claimValue: "metis-developers", role: "developer" },
    ]);
  });

  it("works with no argument", () => {
    expect(() => buildLdapProviderBody()).not.toThrow();
  });

  it("honours custom connection settings and mappings (one admin)", () => {
    const mappings = [
      { claimValue: "ops", role: "admin" },
      { claimValue: "ro", role: "reader" },
    ];
    const body = buildLdapProviderBody({
      url: "ldap://x:1389",
      baseDN: "dc=x",
      bindDN: "cn=svc,dc=x",
      bindPassword: "p",
      userSearchBase: "ou=u,dc=x",
      searchFilter: "(cn={{username}})",
      groupMappings: mappings,
      defaultRole: "developer",
      tlsSkipVerify: true,
      connectionTimeout: 3000,
    });
    expect(body.groupMappings).toEqual(mappings);
    expect(body.searchFilter).toBe("(cn={{username}})");
    expect(body.defaultRole).toBe("developer");
    expect(body.tlsSkipVerify).toBe(true);
    expect(body.connectionTimeout).toBe(3000);
  });

  it("throws when no mapping resolves to admin (mirrors server guard)", () => {
    expect(() =>
      buildLdapProviderBody({ groupMappings: [{ claimValue: "ro", role: "reader" }] }),
    ).toThrow(/at least one mapping with role 'admin'/);
  });

  it("throws when the search filter lacks {{username}}", () => {
    expect(() => buildLdapProviderBody({ searchFilter: "(uid=alice)" })).toThrow(
      /\{\{username\}\}/,
    );
  });
});

describe("frozen defaults", () => {
  it("DEFAULTS, DEFAULT_GROUP_MAPPINGS and SEED_USERS are frozen", () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_GROUP_MAPPINGS)).toBe(true);
    expect(Object.isFrozen(SEED_USERS)).toBe(true);
  });

  it("default mappings returned in a provider body are clones, not the frozen source", () => {
    const body = buildLdapProviderBody();
    body.groupMappings[0].role = "reader";
    expect(DEFAULT_GROUP_MAPPINGS[0].role).toBe("admin");
  });
});
