/**
 * #1381 — METIS's own LDAP provider against the repository's OpenLDAP harness
 * (`docker-compose.ldap.yml`, seeded by `scripts/ldap-harness/memberof-init.sh`).
 *
 * The harness rotted twice without anyone noticing: its image was removed from
 * Docker Hub, and its seed wrote `memberOf` by hand, which slapd refuses without
 * the memberof overlay. Nothing ran it. This suite is what the
 * `ldap-harness` workflow runs against a live container, so a broken image or
 * seed — or a provider change that stops reading the directory's groups — fails
 * a check instead of the next person who needs the harness.
 *
 * Skipped unless `LDAP_HARNESS_URL` is set (e.g. `ldap://localhost:4400`).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  LDAPAuthProvider,
  clearLDAPConfig,
  setLDAPConfig,
  type LDAPConfig,
} from "../src/lib/auth/ldap-provider.js";

const URL = process.env.LDAP_HARNESS_URL;

function harnessConfig(url: string): LDAPConfig {
  return {
    url,
    baseDN: "dc=metis,dc=local",
    bindDN: "cn=admin,dc=metis,dc=local",
    bindPassword: process.env.LDAP_HARNESS_BIND_PASSWORD ?? "adminpassword",
    userSearchBase: "ou=users,dc=metis,dc=local",
    searchFilter: "(&(objectClass=inetOrgPerson)(uid={{username}}))",
    groupMappings: [
      { claimValue: "metis-admins", role: "admin" },
      { claimValue: "metis-developers", role: "developer" },
    ],
    defaultRole: "reader",
    tlsSkipVerify: false,
    connectionTimeout: 10_000,
  };
}

describe.skipIf(!URL)("LDAP login against the local OpenLDAP harness (#1381)", () => {
  afterEach(() => clearLDAPConfig());

  it("alice logs in and her overlay-written memberOf maps to admin", async () => {
    setLDAPConfig(harnessConfig(URL!));
    const result = await new LDAPAuthProvider().authenticate("alice", "alicepass");
    expect(result).toEqual({
      success: true,
      user: {
        username: "alice",
        displayName: "Alice Admin",
        email: "alice@metis.local",
        role: "admin",
        groups: ["metis-admins"],
      },
    });
  });

  it("bob logs in as developer from metis-developers", async () => {
    setLDAPConfig(harnessConfig(URL!));
    const result = await new LDAPAuthProvider().authenticate("bob", "bobpass");
    expect(result).toMatchObject({
      success: true,
      user: { username: "bob", role: "developer", groups: ["metis-developers"] },
    });
  });

  it("a wrong password is refused", async () => {
    setLDAPConfig(harnessConfig(URL!));
    const result = await new LDAPAuthProvider().authenticate("alice", "not-her-password");
    expect(result).toEqual({ success: false, error: "Invalid username or password" });
  });
});
