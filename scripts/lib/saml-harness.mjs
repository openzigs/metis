/**
 * Local SAML test harness — pure helpers (Issue #523, Epic #517).
 *
 * Builds the `PUT /api/admin/auth/providers/saml` request body that points METIS
 * at the local mock SAML IdP (boxyhq/mock-saml), and the matching SP endpoint
 * URLs. Kept side-effect-free (no fetch, no fs, no env) so it is unit-testable
 * with ≥80% coverage; the network/orchestration lives in `seed-saml.mjs` and the
 * `docker-compose.saml.yml` / shell entrypoint.
 *
 * WHY this shape (verified against source, not memory):
 * - The admin route reads `name, entityId, acsUrl, idpMetadataXml, signRequests,
 *   requireSignedResponse, groupMappings, defaultRole` and parses the IdP SSO
 *   URL + certs out of `idpMetadataXml` via `parseIdPMetadata`
 *   (server/src/routes/admin/auth.ts, server/src/lib/auth/saml-provider.ts).
 *   So the seed only needs to hand METIS the mock IdP's metadata XML — METIS
 *   extracts entryPoint/cert/issuer itself, guaranteeing the cert METIS trusts is
 *   exactly the cert the mock signs with.
 * - boxyhq/mock-saml's `createSAMLResponse` signs BOTH the Assertion and the
 *   Response envelope (verified in @boxyhq/saml20 lib/response.ts), so METIS's
 *   #520 secure default `requireSignedResponse: true` works WITHOUT relaxing it.
 * - mock-saml only emits an `email` attribute (no group/role claim), so SAML
 *   role resolution falls through to `defaultRole`. The harness sets a usable
 *   default and documents this.
 *
 * Node built-ins only.
 */

/** Default ports/URLs for the local harness (override via env in the runner). */
export const DEFAULTS = Object.freeze({
  /** Where the mock IdP is published on the host. */
  idpBaseUrl: "http://localhost:4500",
  /** METIS server base (the dev server / docker-compose `server`). */
  metisApiUrl: "http://localhost:4000",
  /** METIS UI base — the SP ACS lives behind the API, see acsPath. */
  spEntityId: "http://localhost:4000/auth/saml/metadata",
  /** Default METIS role for a SAML login (mock IdP emits no group claim). */
  defaultRole: "admin",
  /** Provider display name shown on the METIS login page. */
  providerName: "Local Mock SAML",
});

/**
 * mock-saml's IdP metadata endpoint. boxyhq/mock-saml serves SAML metadata at
 * `/api/saml/metadata` (verified in pages/api/saml/metadata.ts).
 *
 * @param {string} idpBaseUrl
 * @returns {string}
 */
export function idpMetadataUrl(idpBaseUrl) {
  return `${trimSlash(idpBaseUrl)}/api/saml/metadata`;
}

/**
 * mock-saml's SSO endpoint (where METIS sends the AuthnRequest). Present here
 * for documentation/diagnostics; METIS reads the real value out of the metadata.
 *
 * @param {string} idpBaseUrl
 * @returns {string}
 */
export function idpSsoUrl(idpBaseUrl) {
  return `${trimSlash(idpBaseUrl)}/api/saml/sso`;
}

/**
 * METIS SP Assertion Consumer Service URL — the POST target node-saml uses as
 * `callbackUrl`. Mounted at `/auth/saml/acs` (verified in server/src/routes/sso.ts).
 *
 * @param {string} metisApiUrl
 * @returns {string}
 */
export function spAcsUrl(metisApiUrl) {
  return `${trimSlash(metisApiUrl)}/auth/saml/acs`;
}

/**
 * METIS SP entity id / metadata URL (`/auth/saml/metadata`).
 *
 * @param {string} metisApiUrl
 * @returns {string}
 */
export function spEntityId(metisApiUrl) {
  return `${trimSlash(metisApiUrl)}/auth/saml/metadata`;
}

/**
 * @typedef {object} SeedConfigInput
 * @property {string} idpMetadataXml Raw IdP metadata XML fetched from the mock IdP.
 * @property {string} [metisApiUrl] METIS API base (default DEFAULTS.metisApiUrl).
 * @property {string} [name] provider display name.
 * @property {string} [defaultRole] METIS role when no group claim matches.
 * @property {boolean} [requireSignedResponse] override the #520 secure default.
 * @property {boolean} [enabled] whether the provider shows on /login (default true).
 */

/**
 * Build the body for `PUT /api/admin/auth/providers/saml`.
 *
 * Throws on missing/blank metadata so a half-up mock IdP fails loudly instead of
 * silently writing an unusable provider config.
 *
 * @param {SeedConfigInput} input
 * @returns {Record<string, unknown>}
 */
export function buildSamlProviderBody(input) {
  if (!input || typeof input.idpMetadataXml !== "string" || input.idpMetadataXml.trim() === "") {
    throw new Error(
      "buildSamlProviderBody: idpMetadataXml is required and must be non-empty " +
        "(fetch it from the mock IdP's /api/saml/metadata first)",
    );
  }
  const metisApiUrl = input.metisApiUrl ?? DEFAULTS.metisApiUrl;
  return {
    name: input.name ?? DEFAULTS.providerName,
    enabled: input.enabled ?? true,
    entityId: spEntityId(metisApiUrl),
    acsUrl: spAcsUrl(metisApiUrl),
    idpMetadataXml: input.idpMetadataXml,
    // The mock IdP does not require a signed AuthnRequest from the SP, so we
    // keep request-signing off (no SP key needed for the local round-trip).
    signRequests: false,
    // Keep #520's SECURE default. boxyhq/mock-saml signs the Response envelope,
    // so this works without opting out. Only set false for an IdP that cannot
    // sign the envelope (see docs/auth/saml-local-testing.md).
    requireSignedResponse: input.requireSignedResponse ?? true,
    // mock-saml emits no group claim → role comes from defaultRole.
    defaultRole: input.defaultRole ?? DEFAULTS.defaultRole,
    groupMappings: [],
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
