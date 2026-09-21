/**
 * SAML 2.0 authentication provider via @node-saml/passport-saml v5.
 *
 * Epic #748, Issue #749: SAML 2.0 provider.
 * - SP metadata endpoint at /auth/saml/metadata
 * - IdP metadata upload + parse on save
 * - Inspects AuthnContextClassRef for MFA passthrough (#754)
 *
 * Epic #517, Issue #520 — security hardening (OWASP A07):
 * - `validateInResponseTo: ifPresent` + a request-id `cacheProvider` give
 *   InResponseTo / replay protection: the id minted on the AuthnRequest is
 *   single-use, so a captured Response cannot be replayed.
 * - `wantAuthnResponseSigned: true` by default — the Response envelope (not just
 *   the assertion) must be signed unless an admin explicitly opts out.
 * - `acceptedClockSkewMs` is a small (not zero, not unbounded) tolerance so the
 *   assertion `NotOnOrAfter` / SubjectConfirmation window is enforced without
 *   breaking legitimate logins across slightly-skewed clocks.
 *
 * CRITICAL — shared cache across the two legs. `validateInResponseTo` only works
 * if the SAME `cacheProvider` instance is used to (a) save the id when the
 * AuthnRequest is generated and (b) read+remove it when the Response is
 * validated. The SAML instance is therefore built ONCE per config (memoised) and
 * reused across `generateAuthnRequestUrl` + `validateSAMLResponse`, and under
 * multi-replica the cache must be the shared Postgres backend (see
 * saml-request-id-cache.ts) so the two legs can land on different pods.
 */
import {
  SAML,
  ValidateInResponseTo,
  type SamlConfig,
  type CacheProvider,
} from "@node-saml/passport-saml";
import { createChildLogger } from "../logger.js";
import {
  DEFAULT_REQUEST_ID_EXPIRATION_MS,
  resolveSamlRequestIdCache,
} from "./saml-request-id-cache.js";
import type { SSOAuthResult, SAMLConfig } from "./sso-types.js";

const log = createChildLogger("saml-provider");

/**
 * Clock-skew tolerance (ms) for SAML assertion time-window checks
 * (`NotBefore` / `NotOnOrAfter` / SubjectConfirmation). 30s is the conventional
 * SAML default — large enough to absorb normal NTP drift between the IdP and SP,
 * small enough that an expired assertion is rejected promptly. NOT zero (would
 * reject legitimate logins on minor skew) and NOT unbounded (would defeat the
 * NotOnOrAfter expiry this issue enforces).
 */
const SAML_CLOCK_SKEW_MS = 30_000;

/** MFA AuthnContext class refs that indicate MFA was performed. */
const MFA_AUTHN_CONTEXTS = [
  "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:X509",
  "http://schemas.microsoft.com/claims/multipleauthn",
];

/**
 * Parse IdP metadata XML to extract SSO URL, certificates, and issuer.
 * Uses basic XML parsing to avoid heavy dependencies.
 */
export function parseIdPMetadata(xml: string): {
  ssoUrl: string;
  certs: string[];
  issuer: string;
} {
  // Extract entityID
  const entityIdMatch = xml.match(/entityID="([^"]+)"/);
  const issuer = entityIdMatch?.[1] ?? "";

  // Extract SSO URL (HTTP-Redirect binding preferred, fallback to POST)
  const redirectMatch = xml.match(
    /SingleSignOnService[^>]+Binding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-Redirect"[^>]+Location="([^"]+)"/,
  );
  const postMatch = xml.match(
    /SingleSignOnService[^>]+Binding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-POST"[^>]+Location="([^"]+)"/,
  );
  // Also handle Location before Binding
  const redirectMatch2 = xml.match(
    /SingleSignOnService[^>]+Location="([^"]+)"[^>]+Binding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-Redirect"/,
  );
  const postMatch2 = xml.match(
    /SingleSignOnService[^>]+Location="([^"]+)"[^>]+Binding="urn:oasis:names:tc:SAML:2\.0:bindings:HTTP-POST"/,
  );
  const ssoUrl =
    redirectMatch?.[1] ?? redirectMatch2?.[1] ?? postMatch?.[1] ?? postMatch2?.[1] ?? "";

  // Extract X509 certificates (handles both ds: prefixed and non-prefixed)
  const certMatches = xml.matchAll(
    /<(?:ds:)?X509Certificate>([\s\S]*?)<\/(?:ds:)?X509Certificate>/g,
  );
  const certs: string[] = [];
  for (const match of certMatches) {
    const cert = match[1].replace(/\s/g, "");
    if (cert) certs.push(cert);
  }

  return { ssoUrl, certs, issuer };
}

/** Generate SP metadata XML for the IdP to consume. */
export function generateSPMetadata(config: SAMLConfig): string {
  const certElement = config.spCert
    ? `<md:KeyDescriptor use="signing">
        <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
          <ds:X509Data>
            <ds:X509Certificate>${config.spCert.replace(/-----[^-]+-----/g, "").replace(/\s/g, "")}</ds:X509Certificate>
          </ds:X509Data>
        </ds:KeyInfo>
      </md:KeyDescriptor>`
    : "";

  return `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${escapeXml(config.entityId)}">
  <md:SPSSODescriptor AuthnRequestsSigned="${config.signRequests}" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    ${certElement}
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${escapeXml(config.acsUrl)}"
      index="0"
      isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Build the node-saml options for a config, with the #520 secure defaults baked
 * in. `cacheProvider` MUST be supplied by the caller (and shared across legs) so
 * `validateInResponseTo` can match the AuthnRequest id against the Response.
 */
export function buildSamlConfig(config: SAMLConfig, cacheProvider: CacheProvider): SamlConfig {
  const samlConfig: SamlConfig = {
    issuer: config.entityId,
    callbackUrl: config.acsUrl,
    entryPoint: config.idpSsoUrl,
    idpCert: config.idpCerts,
    idpIssuer: config.idpIssuer,
    // The assertion is always required to be signed.
    wantAssertionsSigned: true,
    // #520: require the Response envelope to be signed by default. Secure posture
    // unless an admin explicitly opts out for an IdP that cannot sign it.
    wantAuthnResponseSigned: config.requireSignedResponse !== false,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
    // #520: InResponseTo / replay protection. `ifPresent` validates the id
    // whenever the Response carries one (SP-initiated logins always do) but does
    // not hard-fail a legitimately IdP-initiated Response that has none. The
    // shared cache makes the id single-use, so a replayed Response is rejected.
    validateInResponseTo: ValidateInResponseTo.ifPresent,
    requestIdExpirationPeriodMs: DEFAULT_REQUEST_ID_EXPIRATION_MS,
    cacheProvider,
    // #520: enforce the assertion NotBefore/NotOnOrAfter window with a small,
    // non-zero clock-skew tolerance.
    acceptedClockSkewMs: SAML_CLOCK_SKEW_MS,
  };
  if (config.signRequests && config.spPrivateKey) {
    samlConfig.privateKey = config.spPrivateKey;
  }
  return samlConfig;
}

/**
 * Memoised SAML instances keyed by a fingerprint of the config. The SAME
 * instance — and therefore the SAME `cacheProvider` — must serve both the
 * AuthnRequest (which saves the request id) and the Response validation (which
 * reads+removes it), or `validateInResponseTo` can never match. Re-saving the
 * config (admin PUT) changes the fingerprint and yields a fresh instance.
 */
const samlInstanceCache = new Map<string, SAML>();

/** Stable fingerprint of the security-relevant config fields. */
function configFingerprint(config: SAMLConfig): string {
  return JSON.stringify([
    config.entityId,
    config.acsUrl,
    config.idpSsoUrl,
    config.idpCerts,
    config.idpIssuer,
    config.signRequests,
    config.requireSignedResponse !== false,
    // Include the key material so a rotated SP key rebuilds the instance, but
    // never log this fingerprint (it is only ever a Map key).
    config.spPrivateKey ?? "",
  ]);
}

/**
 * Get (or lazily build) the shared SAML instance for a config. The request-id
 * cache backend is resolved from `SAML_REQUEST_ID_CACHE_BACKEND` (memory default,
 * postgres for multi-replica) so the id minted on one pod is visible on another.
 */
export function getSAMLInstance(config: SAMLConfig): SAML {
  const key = configFingerprint(config);
  let instance = samlInstanceCache.get(key);
  if (!instance) {
    instance = new SAML(buildSamlConfig(config, resolveSamlRequestIdCache()));
    samlInstanceCache.set(key, instance);
  }
  return instance;
}

/** Test helper — clear the memoised SAML instances. */
export function __resetSAMLInstances(): void {
  samlInstanceCache.clear();
}

/** Validate a SAML response and extract user attributes. */
export async function validateSAMLResponse(
  samlResponse: string,
  config: SAMLConfig,
): Promise<SSOAuthResult> {
  try {
    const saml = getSAMLInstance(config);
    const { profile } = await saml.validatePostResponseAsync({
      SAMLResponse: samlResponse,
    });

    if (!profile) {
      return { success: false, error: "No profile in SAML response" };
    }

    const email =
      (profile as Record<string, unknown>)[
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
      ] ??
      (profile as Record<string, unknown>).email ??
      profile.nameID ??
      "";
    const displayName =
      (profile as Record<string, unknown>)[
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"
      ] ??
      (profile as Record<string, unknown>).displayName ??
      (profile as Record<string, unknown>).cn ??
      String(email);
    const username =
      (profile as Record<string, unknown>)[
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn"
      ] ??
      (profile as Record<string, unknown>).uid ??
      String(email).split("@")[0] ??
      "";

    // Extract groups from claims
    const groupClaim =
      (profile as Record<string, unknown>)["http://schemas.xmlsoap.org/claims/Group"] ??
      (profile as Record<string, unknown>).groups ??
      (profile as Record<string, unknown>).memberOf ??
      [];
    const groups = Array.isArray(groupClaim)
      ? (groupClaim as string[])
      : typeof groupClaim === "string"
        ? [groupClaim]
        : [];

    // Check for MFA via AuthnContextClassRef (#754)
    const authnContext =
      (profile as Record<string, unknown>).authnContext ??
      (profile as Record<string, unknown>)[
        "http://schemas.microsoft.com/claims/authnclassreference"
      ] ??
      "";
    const mfaPassed =
      MFA_AUTHN_CONTEXTS.some((ctx) => String(authnContext).includes(ctx)) ||
      String(authnContext).toLowerCase().includes("mfa");

    return {
      success: true,
      user: {
        username: String(username),
        displayName: String(displayName),
        email: String(email),
        groups,
        mfaPassed,
        rawClaims: profile as unknown as Record<string, unknown>,
      },
    };
  } catch (err) {
    log.error("SAML response validation failed", { error: err });
    return {
      success: false,
      error: err instanceof Error ? err.message : "SAML validation failed",
    };
  }
}

/**
 * Generate an AuthnRequest URL for SP-initiated login.
 *
 * Uses the SHARED memoised SAML instance so the request id node-saml saves here
 * (via the request-id cache) is the same id `validateSAMLResponse` later looks up
 * for InResponseTo / replay validation. With a fresh instance per call the id
 * would be saved into a throwaway cache and never matched.
 */
export async function generateAuthnRequestUrl(config: SAMLConfig): Promise<string> {
  const saml = getSAMLInstance(config);
  const url = await saml.getAuthorizeUrlAsync("", undefined, {});
  return url;
}
