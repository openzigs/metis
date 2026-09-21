/**
 * Local OIDC test harness — pure helpers (Issue #521, Epic #517).
 *
 * Builds the `PUT /api/admin/auth/providers/oidc` request body that points METIS
 * at the local Keycloak IdP, plus the matching discovery / callback URLs. Kept
 * side-effect-free (no fetch, no fs, no env) so it is unit-testable with ≥80%
 * coverage; the network/orchestration lives in `seed-oidc.mjs` and the
 * `docker-compose.oidc.yml` / shell entrypoint.
 *
 * WHY this shape (verified against source, not memory):
 * - The admin route reads `name, enabled, discoveryUrl, clientId, clientSecret,
 *   redirectUri, scopes, groupMappings, defaultRole`
 *   (server/src/routes/admin/auth.ts:159-216, verified). `scopes` defaults to
 *   `["openid","profile","email"]` server-side; we send them explicitly and add
 *   nothing extra because the `groups` claim is delivered via Keycloak's
 *   dedicated client scope, not a separate OAuth scope.
 * - The METIS OIDC *callback* (node redirect target) is mounted at
 *   `/api/auth/oidc/callback`: apiRouter is mounted at `/api`
 *   (server/src/app.ts:123), ssoRouter at `/auth` (routes/index.ts:84), route
 *   `/oidc/callback` (routes/sso.ts:202). The Keycloak client's redirect URI MUST
 *   match this exactly, and so must METIS's stored `redirectUri`.
 * - Group→role mapping: the callback calls
 *   `resolveRoleFromGroups(user.groups, provider.groupMappings, provider.defaultRole)`
 *   (sso.ts:248). `user.groups` comes from the `groups` claim
 *   (oidc-provider.ts:100). Each `GroupRoleMapping` is `{ claimValue, role }`
 *   and a match is `groups.includes(mapping.claimValue)` (sso-config.ts:348).
 *   So `claimValue` must equal the Keycloak group NAME (Full group path OFF), and
 *   `validateGroupMappings` REQUIRES at least one mapping resolve to `admin`
 *   (sso-config.ts:318-326) — so the default mapping always includes an admin
 *   group. This is the capability the #523 SAML harness could NOT cover.
 *
 * Node built-ins only.
 */

/** Default ports/URLs/realm for the local harness (override via env in the runner). */
export const DEFAULTS = Object.freeze({
  /** Where Keycloak is published on the host. */
  idpBaseUrl: "http://localhost:4600",
  /** METIS server base (the dev server / docker-compose `server`). */
  metisApiUrl: "http://localhost:4000",
  /** Keycloak realm provisioned by the realm-import JSON. */
  realm: "metis",
  /** Confidential client id registered in the realm import. */
  clientId: "metis",
  /** Confidential client secret registered in the realm import. */
  clientSecret: "metis-local-secret",
  /** Provider display name shown on the METIS login page. */
  providerName: "Local Keycloak (OIDC)",
  /** Default METIS role if a user's groups match no mapping. */
  defaultRole: "reader",
});

/**
 * Default group→role mappings. The Keycloak realm import places the test user in
 * `metis-admins`, and a Group Membership mapper emits group NAMES (Full group
 * path OFF) in the `groups` claim, so these `claimValue`s line up 1:1 with the
 * Keycloak group names. At least one MUST resolve to `admin`
 * (`validateGroupMappings`), otherwise the admin API rejects the PUT.
 */
export const DEFAULT_GROUP_MAPPINGS = Object.freeze([
  Object.freeze({ claimValue: "metis-admins", role: "admin" }),
  Object.freeze({ claimValue: "metis-developers", role: "developer" }),
]);

/** OAuth scopes METIS requests. `groups` rides the dedicated client scope, not a scope. */
export const DEFAULT_SCOPES = Object.freeze(["openid", "profile", "email"]);

/**
 * Keycloak's OIDC discovery document URL for a realm
 * (`/realms/<realm>/.well-known/openid-configuration`). METIS's `discoverOIDC`
 * reads issuer + endpoints from this (oidc-provider.ts:26-39).
 *
 * @param {string} idpBaseUrl
 * @param {string} realm
 * @returns {string}
 */
export function discoveryUrl(idpBaseUrl, realm) {
  if (typeof realm !== "string" || realm.trim() === "") {
    throw new Error("discoveryUrl: realm is required");
  }
  return `${trimSlash(idpBaseUrl)}/realms/${realm}/.well-known/openid-configuration`;
}

/**
 * METIS OIDC callback URL (the authorization-code redirect target). Mounted at
 * `/api/auth/oidc/callback` — see WHY note above. This is both METIS's stored
 * `redirectUri` AND the value the Keycloak client must list as a Valid Redirect
 * URI; the realm import uses the same default.
 *
 * @param {string} metisApiUrl
 * @returns {string}
 */
export function oidcCallbackUrl(metisApiUrl) {
  return `${trimSlash(metisApiUrl)}/api/auth/oidc/callback`;
}

/**
 * @typedef {object} SeedConfigInput
 * @property {string} [idpBaseUrl] Keycloak base (default DEFAULTS.idpBaseUrl).
 * @property {string} [realm] Keycloak realm (default DEFAULTS.realm).
 * @property {string} [metisApiUrl] METIS API base (default DEFAULTS.metisApiUrl).
 * @property {string} [name] provider display name.
 * @property {string} [clientId] OIDC client id (default DEFAULTS.clientId).
 * @property {string} [clientSecret] OIDC client secret (default DEFAULTS.clientSecret).
 * @property {string} [defaultRole] METIS role when no group claim matches.
 * @property {Array<{claimValue:string, role:string}>} [groupMappings] group→role mappings.
 * @property {string[]} [scopes] OAuth scopes (default DEFAULT_SCOPES).
 * @property {boolean} [enabled] whether the provider shows on /login (default true).
 */

/**
 * Build the body for `PUT /api/admin/auth/providers/oidc`.
 *
 * Throws on a missing/blank client secret so a misconfigured harness fails loudly
 * instead of silently writing an unusable provider (the admin API would reject it
 * anyway, but failing in the builder yields a clearer message).
 *
 * @param {SeedConfigInput} [input]
 * @returns {Record<string, unknown>}
 */
export function buildOidcProviderBody(input = {}) {
  const clientSecret = input.clientSecret ?? DEFAULTS.clientSecret;
  if (typeof clientSecret !== "string" || clientSecret.trim() === "") {
    throw new Error(
      "buildOidcProviderBody: clientSecret is required and must be non-empty " +
        "(it must match the secret in the Keycloak realm import)",
    );
  }
  const idpBaseUrl = input.idpBaseUrl ?? DEFAULTS.idpBaseUrl;
  const realm = input.realm ?? DEFAULTS.realm;
  const metisApiUrl = input.metisApiUrl ?? DEFAULTS.metisApiUrl;
  const groupMappings = input.groupMappings ?? DEFAULT_GROUP_MAPPINGS.map((m) => ({ ...m }));

  if (!groupMappings.some((m) => m.role === "admin")) {
    // Mirror the server-side validateGroupMappings guard so the harness can't
    // ship a config the admin API will reject (sso-config.ts:318-326).
    throw new Error(
      "buildOidcProviderBody: groupMappings must include at least one mapping " +
        "with role 'admin' (server-side validateGroupMappings rejects otherwise)",
    );
  }

  return {
    name: input.name ?? DEFAULTS.providerName,
    enabled: input.enabled ?? true,
    discoveryUrl: discoveryUrl(idpBaseUrl, realm),
    clientId: input.clientId ?? DEFAULTS.clientId,
    clientSecret,
    redirectUri: oidcCallbackUrl(metisApiUrl),
    scopes: input.scopes ?? [...DEFAULT_SCOPES],
    groupMappings,
    defaultRole: input.defaultRole ?? DEFAULTS.defaultRole,
  };
}

/**
 * Strip a single trailing slash so URL joins don't produce `//`.
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
