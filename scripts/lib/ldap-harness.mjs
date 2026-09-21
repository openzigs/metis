/**
 * Local LDAP test harness — pure helpers (Issue #525, Epic #517).
 *
 * Unlike the OIDC (#521) and SAML (#523) harnesses — which configure METIS
 * through the admin API — **LDAP is ENV-DRIVEN**: the active login provider is
 * selected by `AUTH_MODE=ldap` and reads its connection settings from
 * `AUTH_LDAP_*` env vars (server/src/lib/auth/ldap-provider.ts `getLDAPConfig`).
 * So this helper's job is twofold and side-effect-free (no fetch/fs/env) so it
 * is unit-testable with ≥80% coverage:
 *
 *   1. `buildLdapEnvBlock()` — the exact `AUTH_LDAP_*` env block a developer
 *      exports to point METIS at the local OpenLDAP container. The var NAMES are
 *      derived from the provider source, NOT memory (see WHY below).
 *   2. `resolveRoleForGroups()` / `expectedRoleForUser()` — a faithful re-impl of
 *      the server's `resolveRoleFromGroups` (sso-config.ts) used by the seed
 *      script's bind+search SMOKE CHECK to assert each seeded user's `memberOf`
 *      groups map to the expected METIS role. This is how the harness verifies
 *      group→role mapping deterministically without a live METIS server.
 *
 * The live OpenLDAP container + the end-to-end METIS login round-trip stay a
 * documented manual `make ldap-up` target (see docs/auth/ldap-local-testing.md),
 * NOT a CI job.
 *
 * WHY this shape (verified against source, not memory):
 * - `getLDAPConfig()` reads exactly: AUTH_LDAP_URL, AUTH_LDAP_BASE_DN,
 *   AUTH_LDAP_BIND_DN, AUTH_LDAP_BIND_PASSWORD, AUTH_LDAP_USER_SEARCH_BASE,
 *   AUTH_LDAP_SEARCH_FILTER, AUTH_LDAP_TLS_SKIP_VERIFY, AUTH_LDAP_CONNECTION_TIMEOUT
 *   (ldap-provider.ts:37-48, verified). We emit precisely those names.
 * - The provider's DEFAULT search filter is Active-Directory shaped
 *   (`(&(objectClass=user)(sAMAccountName={{username}}))`, ldap-provider.ts:43).
 *   OpenLDAP users are `inetOrgPerson` keyed by `uid`, so we OVERRIDE the filter
 *   via AUTH_LDAP_SEARCH_FILTER to `(&(objectClass=inetOrgPerson)(uid={{username}}))`.
 *   The provider substitutes `{{username}}` after RFC-4515 escaping
 *   (escapeLDAPFilter, ldap-provider.ts:240) — our default filter keeps the
 *   `{{username}}` token verbatim for that substitution.
 * - Group→role mapping for LDAP flows through `memberOf`: the provider reads the
 *   `memberOf` attribute and extracts the CN of each group DN via the regex
 *   `^CN=([^,]+)` (case-INsensitive, ldap-provider.ts:108-115). Our seed LDIF
 *   therefore puts each user in `groupOfNames` groups and stamps the user's
 *   `memberOf` with the FULL group DN (`cn=metis-admins,ou=groups,...`); the
 *   provider's regex extracts `metis-admins`. Those names are the `claimValue`s.
 * - `resolveRoleFromGroups(groups, mappings, defaultRole)` returns the
 *   HIGHEST-privilege matched role (hierarchy reader<developer<coordinator<admin,
 *   sso-config.ts:329-358); empty mappings OR empty groups → defaultRole. Our
 *   `resolveRoleForGroups` mirrors that exactly so the smoke check is honest.
 * - Env-only LDAP config has `groupMappings: []` (ldap-provider.ts:44), so a pure
 *   env login resolves to `defaultRole` for everyone. To make group→role mapping
 *   take effect at LOGIN, the mappings must be set via the admin API
 *   (`PUT /api/admin/auth/providers/ldap`, admin/auth.ts:270-314, which merges
 *   `groupMappings`). `buildLdapProviderBody()` produces that body, and the docs
 *   explain both paths.
 *
 * Node built-ins only.
 */

/**
 * METIS role privilege hierarchy — MUST match sso-config.ts:336-341.
 *
 * @type {Record<string, number>}
 */
const ROLE_HIERARCHY = Object.freeze({
  reader: 10,
  developer: 20,
  coordinator: 30,
  admin: 99,
});

/**
 * Default ports / DNs / creds for the local harness (override via env in the
 * runner). Host port 4400 is chosen so it never collides with the METIS server
 * (:4000), the SAML mock IdP (:4500), or Keycloak (:4600).
 */
export const DEFAULTS = Object.freeze({
  /** Where OpenLDAP is published on the host (ldap://, not ldaps://). */
  url: "ldap://localhost:4400",
  /** Root suffix / baseDN of the directory tree. */
  baseDN: "dc=metis,dc=local",
  /** Service-account (root) bind DN the provider binds with to SEARCH. */
  bindDN: "cn=admin,dc=metis,dc=local",
  /** Service-account bind password. */
  bindPassword: "adminpassword",
  /** Subtree the provider searches for users (the users OU). */
  userSearchBase: "ou=users,dc=metis,dc=local",
  /**
   * User search filter. OVERRIDES the provider's AD-shaped default because
   * OpenLDAP users are `inetOrgPerson` keyed by `uid`. `{{username}}` is
   * substituted (after RFC-4515 escaping) by the provider at login.
   */
  searchFilter: "(&(objectClass=inetOrgPerson)(uid={{username}}))",
  /** Subtree groups live under (used by the LDIF + docs, not a provider env). */
  groupSearchBase: "ou=groups,dc=metis,dc=local",
  /** METIS role when a user's groups match no mapping. */
  defaultRole: "reader",
  /** Provider display name (admin-API path only). */
  providerName: "Local OpenLDAP",
  /** Connection timeout (ms) the provider uses. */
  connectionTimeout: 10000,
});

/**
 * Default group→role mappings. The seed LDIF puts `alice` in `metis-admins` and
 * `bob` in `metis-developers`; the provider extracts those CNs from `memberOf`.
 * At least one mapping MUST resolve to `admin` (mirrors the server-side
 * `validateGroupMappings` guard, sso-config.ts) so the admin-API path is accepted.
 */
export const DEFAULT_GROUP_MAPPINGS = Object.freeze([
  Object.freeze({ claimValue: "metis-admins", role: "admin" }),
  Object.freeze({ claimValue: "metis-developers", role: "developer" }),
]);

/**
 * The seeded test users and the groups they belong to (the LDIF is generated to
 * match this). Used by the seed script's smoke check to assert each user's
 * directory entry resolves to the expected role.
 */
export const SEED_USERS = Object.freeze([
  Object.freeze({
    uid: "alice",
    password: "alicepass",
    displayName: "Alice Admin",
    mail: "alice@metis.local",
    groups: Object.freeze(["metis-admins"]),
    expectedRole: "admin",
  }),
  Object.freeze({
    uid: "bob",
    password: "bobpass",
    displayName: "Bob Developer",
    mail: "bob@metis.local",
    groups: Object.freeze(["metis-developers"]),
    expectedRole: "developer",
  }),
]);

/**
 * Strip a single (or repeated) trailing slash so URL joins don't produce `//`.
 *
 * @param {string} url
 * @returns {string}
 */
export function trimSlash(url) {
  if (typeof url !== "string") {
    throw new TypeError("trimSlash: url must be a string");
  }
  return url.replace(/\/+$/, "");
}

/**
 * Build a `uid=<uid>,<userSearchBase>` user DN (matches the seed LDIF layout).
 *
 * @param {string} uid
 * @param {string} [userSearchBase]
 * @returns {string}
 */
export function userDn(uid, userSearchBase = DEFAULTS.userSearchBase) {
  if (typeof uid !== "string" || uid.trim() === "") {
    throw new Error("userDn: uid is required");
  }
  return `uid=${uid},${userSearchBase}`;
}

/**
 * Build a `cn=<group>,<groupSearchBase>` group DN (matches the seed LDIF layout
 * and the `memberOf` values the provider extracts CNs from).
 *
 * @param {string} cn
 * @param {string} [groupSearchBase]
 * @returns {string}
 */
export function groupDn(cn, groupSearchBase = DEFAULTS.groupSearchBase) {
  if (typeof cn !== "string" || cn.trim() === "") {
    throw new Error("groupDn: cn is required");
  }
  return `cn=${cn},${groupSearchBase}`;
}

/**
 * @typedef {object} LdapEnvInput
 * @property {string} [url] LDAP URL (default DEFAULTS.url).
 * @property {string} [baseDN] root suffix (default DEFAULTS.baseDN).
 * @property {string} [bindDN] service-account bind DN (default DEFAULTS.bindDN).
 * @property {string} [bindPassword] service-account password (default DEFAULTS.bindPassword).
 * @property {string} [userSearchBase] user subtree (default DEFAULTS.userSearchBase).
 * @property {string} [searchFilter] user search filter (default DEFAULTS.searchFilter).
 * @property {number} [connectionTimeout] timeout ms (default DEFAULTS.connectionTimeout).
 * @property {boolean} [tlsSkipVerify] skip TLS verify (default false; harness is plain ldap://).
 */

/**
 * Build the `AUTH_LDAP_*` env block a developer exports to point METIS at the
 * local OpenLDAP. Keys are EXACTLY the names `getLDAPConfig()` reads, plus
 * `AUTH_MODE=ldap` (LDAP is the active login provider, selected by AUTH_MODE —
 * unlike OIDC/SAML which are admin-API SSO routes). Returns a plain object of
 * string values so the runner can print/export it deterministically.
 *
 * Throws on a blank bind password so a misconfigured harness fails loudly rather
 * than producing an env block that silently can't bind.
 *
 * @param {LdapEnvInput} [input]
 * @returns {Record<string, string>}
 */
export function buildLdapEnvBlock(input = {}) {
  const bindPassword = input.bindPassword ?? DEFAULTS.bindPassword;
  if (typeof bindPassword !== "string" || bindPassword.trim() === "") {
    throw new Error(
      "buildLdapEnvBlock: bindPassword is required and must be non-empty " +
        "(it must match the OpenLDAP admin password from docker-compose.ldap.yml)",
    );
  }
  const searchFilter = input.searchFilter ?? DEFAULTS.searchFilter;
  if (!searchFilter.includes("{{username}}")) {
    // The provider substitutes {{username}} at login; without it no user is found.
    throw new Error(
      "buildLdapEnvBlock: searchFilter must contain the {{username}} placeholder " +
        "(the provider substitutes the login username into it)",
    );
  }

  return {
    AUTH_MODE: "ldap",
    AUTH_LDAP_URL: input.url ?? DEFAULTS.url,
    AUTH_LDAP_BASE_DN: input.baseDN ?? DEFAULTS.baseDN,
    AUTH_LDAP_BIND_DN: input.bindDN ?? DEFAULTS.bindDN,
    AUTH_LDAP_BIND_PASSWORD: bindPassword,
    AUTH_LDAP_USER_SEARCH_BASE: input.userSearchBase ?? DEFAULTS.userSearchBase,
    AUTH_LDAP_SEARCH_FILTER: searchFilter,
    AUTH_LDAP_TLS_SKIP_VERIFY: String(input.tlsSkipVerify ?? false),
    AUTH_LDAP_CONNECTION_TIMEOUT: String(input.connectionTimeout ?? DEFAULTS.connectionTimeout),
  };
}

/**
 * Render an env block (object) as exportable `KEY="value"` lines for a `.env`
 * file or `eval "$(...)"`. Values are double-quoted; embedded `"` and `\` are
 * escaped so DNs with special characters survive a shell.
 *
 * @param {Record<string, string>} envBlock
 * @returns {string}
 */
export function renderEnvExport(envBlock) {
  if (envBlock === null || typeof envBlock !== "object") {
    throw new TypeError("renderEnvExport: envBlock must be an object");
  }
  return Object.entries(envBlock)
    .map(([k, v]) => {
      const escaped = String(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return `export ${k}="${escaped}"`;
    })
    .join("\n");
}

/**
 * Faithful re-implementation of the server's `resolveRoleFromGroups`
 * (sso-config.ts:329-358) for the seed smoke check: returns the highest-privilege
 * role among the matched mappings; empty mappings OR empty groups → defaultRole.
 *
 * @param {string[]} groups Group NAMES (CNs) the user belongs to.
 * @param {Array<{claimValue:string, role:string}>} mappings group→role mappings.
 * @param {string} defaultRole role when nothing matches.
 * @returns {string}
 */
export function resolveRoleForGroups(groups, mappings, defaultRole) {
  if (!Array.isArray(groups) || !Array.isArray(mappings)) {
    throw new TypeError("resolveRoleForGroups: groups and mappings must be arrays");
  }
  if (mappings.length === 0 || groups.length === 0) return defaultRole;

  let bestRole = defaultRole;
  let bestLevel = ROLE_HIERARCHY[defaultRole] ?? 0;
  for (const mapping of mappings) {
    if (groups.includes(mapping.claimValue)) {
      const level = ROLE_HIERARCHY[mapping.role] ?? 0;
      if (level > bestLevel) {
        bestRole = mapping.role;
        bestLevel = level;
      }
    }
  }
  return bestRole;
}

/**
 * The METIS role a seeded user is expected to resolve to, given the default
 * mappings (or an override). Used by the smoke check to assert the directory was
 * seeded such that group→role mapping works.
 *
 * @param {{groups: ReadonlyArray<string>}} user a SEED_USERS entry.
 * @param {Array<{claimValue:string, role:string}>} [mappings] default DEFAULT_GROUP_MAPPINGS.
 * @param {string} [defaultRole] default DEFAULTS.defaultRole.
 * @returns {string}
 */
export function expectedRoleForUser(
  user,
  mappings = DEFAULT_GROUP_MAPPINGS.map((m) => ({ ...m })),
  defaultRole = DEFAULTS.defaultRole,
) {
  if (!user || !Array.isArray(user.groups)) {
    throw new TypeError("expectedRoleForUser: user.groups must be an array");
  }
  return resolveRoleForGroups([...user.groups], mappings, defaultRole);
}

/**
 * @typedef {object} LdapProviderInput
 * @property {string} [url]
 * @property {string} [baseDN]
 * @property {string} [bindDN]
 * @property {string} [bindPassword]
 * @property {string} [userSearchBase]
 * @property {string} [searchFilter]
 * @property {Array<{claimValue:string, role:string}>} [groupMappings]
 * @property {string} [defaultRole]
 * @property {number} [connectionTimeout]
 * @property {boolean} [tlsSkipVerify]
 */

/**
 * Build the body for `PUT /api/admin/auth/providers/ldap` (admin/auth.ts:270).
 * This is the ONLY mechanism that populates `groupMappings` for LDAP, so it is
 * how a developer makes group→role mapping take effect at LOGIN (env-only config
 * has empty mappings → everyone gets `defaultRole`). Mirrors the OIDC harness's
 * admin guard: at least one mapping must resolve to `admin`.
 *
 * @param {LdapProviderInput} [input]
 * @returns {Record<string, unknown>}
 */
export function buildLdapProviderBody(input = {}) {
  const groupMappings = input.groupMappings ?? DEFAULT_GROUP_MAPPINGS.map((m) => ({ ...m }));
  if (!groupMappings.some((m) => m.role === "admin")) {
    throw new Error(
      "buildLdapProviderBody: groupMappings must include at least one mapping " +
        "with role 'admin' (server-side validateGroupMappings rejects otherwise)",
    );
  }
  const searchFilter = input.searchFilter ?? DEFAULTS.searchFilter;
  if (!searchFilter.includes("{{username}}")) {
    throw new Error(
      "buildLdapProviderBody: searchFilter must contain the {{username}} placeholder",
    );
  }
  return {
    url: input.url ?? DEFAULTS.url,
    baseDN: input.baseDN ?? DEFAULTS.baseDN,
    bindDN: input.bindDN ?? DEFAULTS.bindDN,
    bindPassword: input.bindPassword ?? DEFAULTS.bindPassword,
    userSearchBase: input.userSearchBase ?? DEFAULTS.userSearchBase,
    searchFilter,
    groupMappings,
    defaultRole: input.defaultRole ?? DEFAULTS.defaultRole,
    tlsSkipVerify: input.tlsSkipVerify ?? false,
    connectionTimeout: input.connectionTimeout ?? DEFAULTS.connectionTimeout,
  };
}
